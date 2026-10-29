import fs from "node:fs";
import path from "node:path";
import { syslog } from "@/lib/observability/log-store";
import { env } from "@/env";
import { getSettingDb } from "@/lib/settings-service";
import {
  loadOrt,
  acquireOnnxSession,
  releaseOnnxSession,
  isOnnxSessionLoaded,
  ONNX_SLOT_RERANKER,
  recordInferenceLatency,
  getOnnxSlotTelemetry,
  type OrtModule,
  type OnnxTelemetry,
} from "./onnx-session";
// Circular-safe: store.ts imports CANONICAL_RERANKER_DIR from here, but only
// reads it inside functions (never at module-init time).
import { discoverModels } from "@/lib/models/store";
import { loadTokenizer, type Tokenizer } from "./tokenizer";
import { normalizeEmbeddingBaseUrl } from "./embeddings";

/** Lazy-load provider-config store (secrets + registry) — server-only. */
async function loadProviderConfigStore(): Promise<typeof import("@/lib/ai/provider-config/store")> {
  return await import("@/lib/ai/provider-config/store");
}

/** Reranker provider kind: local ONNX or a remote OpenAI-compatible API. */
export type RerankerProvider = "onnx" | "openai-compatible";

export type RerankerDbSetting = {
  enabled?: boolean;
  /** Provider kind. Absent (legacy) configs default to `"onnx"`. */
  provider?: RerankerProvider;
  /** Local ONNX model path/filename (provider === "onnx"). */
  selectedModel?: string;
  /** Remote endpoint base URL (provider === "openai-compatible"). */
  baseUrl?: string;
  /** Env-var name holding the remote API key (e.g. "PROVIDER_NVIDIA_API_KEY"). */
  apiKeyEnv?: string;
  /** Remote model name (provider === "openai-compatible"). */
  model?: string;
  /** ONNX session idle timeout in minutes (provider === "onnx"). */
  idleTimeoutMinutes?: number;
};

/**
 * Canonical directory where user-placed ONNX reranker models are placed.
 * Models here are discovered and listed in the settings UI, but activation
 * requires explicit user configuration — there is no hardcoded default.
 */
export const CANONICAL_RERANKER_DIR = path.resolve(
  /* turbopackIgnore: true */ process.cwd(),
  /* turbopackIgnore: true */ "data/models/reranker"
);

/** Minimum byte length for an ONNX model file (~50MB) to reject stubs/404s. */
const MIN_MODEL_SIZE_BYTES = 50 * 1024 * 1024;

let customModelPathResolver: (() => string | null) | null = null;
let customDbSettingResolver: (() => RerankerDbSetting | null) | null = null;

export interface DiscoveredRerankerModel {
  filename: string;
  path: string;
  sizeBytes: number;
  isDefault: boolean;
}

let customDiscoveredModelsResolver: (() => DiscoveredRerankerModel[]) | null = null;

/** Test hook: override model path resolution in unit tests. */
export function setModelPathResolverForTest(resolver: (() => string | null) | null): void {
  customModelPathResolver = resolver;
}

/** Test hook: override database setting resolution in unit tests. */
export function setRerankerDbSettingResolverForTest(
  resolver: (() => RerankerDbSetting | null) | null
): void {
  customDbSettingResolver = resolver;
}

/** Test hook: override discovered models in unit tests. */
export function setDiscoveredModelsResolverForTest(
  resolver: (() => DiscoveredRerankerModel[]) | null
): void {
  customDiscoveredModelsResolver = resolver;
}

/** Reads the current reranker configuration from database settings. */
export function getRerankerDbSetting(): RerankerDbSetting | null {
  if (customDbSettingResolver) {
    return customDbSettingResolver();
  }
  try {
    const raw = getSettingDb("reranker");
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      return raw as RerankerDbSetting;
    }
    return null;
  } catch (err) {
    syslog("debug", "reranker", `getRerankerDbSetting failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Resolved reranker configuration: either a local ONNX model or a remote endpoint. */
export type ResolvedRerankerConfig =
  | {
      kind: "onnx";
      modelPath: string;
      idleTimeoutMs: number;
    }
  | {
      kind: "openai-compatible";
      baseUrl: string;
      apiKey: string | undefined;
      model: string;
    };

/**
 * Resolve the effective reranker configuration from DB settings + env.
 * Legacy configs (no `provider` field) default to `"onnx"`.
 */
export async function resolveRerankerConfig(): Promise<ResolvedRerankerConfig | null> {
  const dbSetting = getRerankerDbSetting();
  const provider: RerankerProvider =
    dbSetting?.provider ?? env.RERANKER_PROVIDER ?? "onnx";

  if (provider === "onnx") {
    const modelPath = resolveRerankerModelPath();
    if (!modelPath) return null;
    return {
      kind: "onnx",
      modelPath,
      idleTimeoutMs: resolveRerankerIdleTimeoutMs(),
    };
  }

  // Remote (openai-compatible) mode.
  const baseUrl = dbSetting?.baseUrl ?? env.RERANKER_REMOTE_URL;
  if (!baseUrl) return null;

  const model = dbSetting?.model ?? env.RERANKER_MODEL_ID;
  if (!model) return null;

  // Resolve API key: provider-registry entry for this URL first (shared secret),
  // then the setting's own apiKeyEnv.
  let apiKey: string | undefined;
  try {
    const { loadRegistry, resolveApiKey } = await loadProviderConfigStore();
    const registry = await loadRegistry();
    const providers = Array.isArray(registry?.providers) ? registry.providers : [];

    // Look for a registered provider on the same endpoint (reuses stored secret).
    const normalized = normalizeEmbeddingBaseUrl(baseUrl);
    const match = providers.find(
      (p) =>
        typeof p.baseUrl === "string" &&
        normalizeEmbeddingBaseUrl(p.baseUrl) === normalized
    );
    if (match) {
      apiKey = await resolveApiKey(match);
    }
    // Fall back to the setting's own apiKeyEnv environment variable.
    if (!apiKey && dbSetting?.apiKeyEnv) {
      apiKey = process.env[dbSetting.apiKeyEnv];
    }
  } catch (err) {
    syslog(
      "warn",
      "reranker",
      `Failed to resolve reranker API key: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    kind: "openai-compatible",
    baseUrl,
    apiKey,
    model,
  };
}

/**
 * Checks whether the reranker is enabled.
 * Inspects both the database setting (key "reranker") and env.RERANKER_ENABLED.
 */
export function isRerankerEnabled(): boolean {
  if (!env.RERANKER_ENABLED) return false;
  const dbSetting = getRerankerDbSetting();
  if (dbSetting && typeof dbSetting.enabled === "boolean") {
    return dbSetting.enabled;
  }
  return true;
}

/**
 * Resolves the effective idle timeout in milliseconds before session auto-release.
 * Respects dbSetting.idleTimeoutMinutes if configured, falling back to
 * env.RERANKER_IDLE_TIMEOUT_MS (default 900_000 ms / 15 minutes).
 * A value of 0 indicates always-on (never auto-release).
 */
export function resolveRerankerIdleTimeoutMs(): number {
  const dbSetting = getRerankerDbSetting();
  if (
    dbSetting?.idleTimeoutMinutes !== undefined &&
    typeof dbSetting.idleTimeoutMinutes === "number"
  ) {
    if (dbSetting.idleTimeoutMinutes <= 0) {
      // 0 = always on (held for 24h before eviction)
      return 24 * 60 * 60 * 1000;
    }
    return dbSetting.idleTimeoutMinutes * 60 * 1000;
  }
  return env.RERANKER_IDLE_TIMEOUT_MS ?? 15 * 60 * 1000;
}

/**
 * Asynchronously pre-warms the reranker session in the background so cold-start
 * is eliminated before the user finishes typing or submits a search.
 * Returns true if session is ready (or loading started), false if disabled or no model.
 */
export async function warmRerankerSession(): Promise<boolean> {
  if (!isRerankerEnabled()) return false;
  const modelPath = resolveRerankerModelPath();
  if (!modelPath) return false;

  try {
    await acquireOnnxSession(
      ONNX_SLOT_RERANKER,
      modelPath,
      RERANKER_CREATE_OPTIONS,
      resolveRerankerIdleTimeoutMs()
    );
    return true;
  } catch (err) {
    syslog("debug", "reranker", `warmRerankerSession failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Discover locally installed reranker models via the shared model store.
 *
 * Delegates to `store.discoverModels("reranker")`, mapping the generic
 * `DiscoveredModel` shape onto `DiscoveredRerankerModel`. The
 * `customDiscoveredModelsResolver` test hook is preserved so existing
 * reranker tests are unaffected.
 */
export function discoverRerankerModels(): DiscoveredRerankerModel[] {
  if (customDiscoveredModelsResolver) {
    return customDiscoveredModelsResolver();
  }
  const discovered = discoverModels("reranker");
  const models: DiscoveredRerankerModel[] = discovered.map((m) => ({
    filename: m.filename,
    path: m.path,
    sizeBytes: m.sizeBytes,
    isDefault: false,
  }));
  models.sort((a, b) => a.filename.localeCompare(b.filename));
  return models;
}

function isValidModelFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(/* turbopackIgnore: true */ filePath);
    return stat.isFile() && stat.size >= MIN_MODEL_SIZE_BYTES;
  } catch (err) {
    syslog("debug", "reranker", `Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Resolves the path to the reranker model file:
 * 1. customModelPathResolver if active (unit test hook).
 * 2. User-configured selectedModel in database settings (settings table key "reranker").
 * 3. env.RERANKER_MODEL_PATH if specified and valid.
 * 4. First discovered model from CANONICAL_RERANKER_DIR (user-placed only).
 * Returns null if no valid model file exists on disk.
 */
export function resolveRerankerModelPath(): string | null {
  if (customModelPathResolver) {
    return customModelPathResolver();
  }

  // 1. User-configured selectedModel in database settings
  const dbSetting = getRerankerDbSetting();
  if (dbSetting?.selectedModel && typeof dbSetting.selectedModel === "string") {
    const selected = dbSetting.selectedModel.trim();
    if (selected.length > 0) {
      const candidatePath = path.isAbsolute(selected)
        ? selected
        : path.join(CANONICAL_RERANKER_DIR, selected);
      if (isValidModelFile(candidatePath)) {
        return candidatePath;
      }
    }
  }

  // 2. Explicit environment override
  const configured = env.RERANKER_MODEL_PATH;
  if (configured && isValidModelFile(configured)) {
    return configured;
  }

  // 3. First discovered model in CANONICAL_RERANKER_DIR (user-placed only —
  //    no hardcoded defaults; the user must explicitly configure or place a model)
  const discovered = discoverRerankerModels();
  if (discovered.length > 0) {
    return discovered[0].path;
  }

  return null;
}

export type RerankerStatus = {
  enabled: boolean;
  environmentEnabled?: boolean;
  available: boolean;
  loaded: boolean;
  /** Provider kind: local ONNX or remote OpenAI-compatible endpoint. */
  provider: "onnx" | "openai-compatible";
  modelPath: string | null;
  sizeBytes?: number;
  /** Remote endpoint base URL (when provider === "openai-compatible"). */
  baseUrl?: string;
  /** Remote model name (when provider === "openai-compatible"). */
  model?: string;
  mode: "active" | "standby" | "fallback" | "disabled";
  discoveredModels: Array<{ filename: string; sizeBytes: number }>;
  telemetry?: OnnxTelemetry | null;
};

/**
 * Reports current diagnostic status of the neural reranker system.
 * Async in remote mode to allow a lightweight probe of the endpoint.
 */
export async function getRerankerStatus(): Promise<RerankerStatus> {
  const enabled = isRerankerEnabled();

  // Resolve effective provider: db setting > env override > legacy "onnx".
  const dbSetting = getRerankerDbSetting();
  const provider: RerankerProvider =
    dbSetting?.provider ?? env.RERANKER_PROVIDER ?? "onnx";

  const discovered = discoverRerankerModels();
  const discoveredModels = discovered.map((m) => ({
    filename: m.filename,
    sizeBytes: m.sizeBytes,
  }));

  if (provider === "openai-compatible") {
    const baseUrl = dbSetting?.baseUrl ?? env.RERANKER_REMOTE_URL;
    const model = dbSetting?.model ?? env.RERANKER_MODEL_ID;
    const available = Boolean(baseUrl && model);

    let mode: RerankerStatus["mode"] = "disabled";
    if (enabled) {
      if (available) mode = "standby"; // remote: no local session concept
      else mode = "fallback";
    }

    return {
      enabled,
      environmentEnabled: env.RERANKER_ENABLED,
      available,
      loaded: false, // remote has no "loaded session" concept
      provider: "openai-compatible",
      modelPath: null,
      baseUrl,
      model,
      sizeBytes: undefined,
      mode,
      discoveredModels,
      telemetry: null,
    };
  }

  // Local ONNX path.
  const resolvedPath = resolveRerankerModelPath();
  const loaded = isRerankerLoaded();
  let mode: RerankerStatus["mode"] = "disabled";
  if (enabled) {
    if (loaded) mode = "active";
    else if (resolvedPath) mode = "standby";
    else mode = "fallback";
  }

  let sizeBytes: number | undefined;
  if (resolvedPath) {
    const matched = discovered.find((m) => m.path === resolvedPath);
    if (matched) {
      sizeBytes = matched.sizeBytes;
    } else {
      try {
        sizeBytes = fs.statSync(/* turbopackIgnore: true */ resolvedPath).size;
      } catch (err) {
        syslog("debug", "reranker", `Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    enabled,
    environmentEnabled: env.RERANKER_ENABLED,
    available: resolvedPath !== null,
    loaded,
    provider: "onnx",
    modelPath: resolvedPath,
    sizeBytes,
    mode,
    discoveredModels,
    telemetry: getOnnxSlotTelemetry(ONNX_SLOT_RERANKER),
  };
}

/**
 * Lazy ONNX reranker for bge-reranker-v2-m3 (INT8).
 *
 * Architecture: XLMRobertaForSequenceClassification cross-encoder (568M
 * params, 100+ languages). Takes (query, document) pairs concatenated as
 * [CLS] query [SEP] document [SEP] and outputs a single relevance logit per
 * pair. Higher logit → more relevant. Apply sigmoid for a [0,1] score.
 *
 * Model acquisition:
 *   pip install -U "optimum[exporters,onnxruntime]"
 *   optimum-cli export onnx \
 *     --model BAAI/bge-reranker-v2-m3 \
 *     --task text-classification --opset 17 ./export
 *   optimum-cli onnxruntime quantize --avx2 \
 *     --onnx_model ./export/onnx -o ./export/onnx-int8
 *   # set RERANKER_MODEL_PATH=/absolute/path/to/model_quantized.onnx
 *   # set RERANKER_ENABLED=true
 *   pnpm add onnxruntime-node
 *
 * Memory contract (lazy + auto-release):
 *   - Session loaded only on first rerank call after boot / idle release.
 *   - Peak RAM ≈ 1.5–2 GB (INT8 weights 544 MB + activations at batch=30).
 *   - Session released after RERANKER_IDLE_TIMEOUT_MS (default 120 s) of
 *     inactivity. Critical: V8 GC cannot reclaim native ORT memory; only
 *     session.release() does. Linux glibc arenas also leak without
 *     malloc_trim(0) after release.
 *   - enableCpuMemArena: false prevents arena growth so memory returns to OS.
 *
 * ONNX Runtime known issue (ort#23282):
 *   executionMode must be 'sequential' — parallel mode is 15× slower for
 *   this model architecture on both CPU and GPU.
 *
 * Tokenizer:
 *   XLM-RoBERTa SentencePiece BPE (250K vocab). The naïve stub below
 *   is replaced by AutoTokenizer once @huggingface/transformers is added
 *   as a dependency. All tensor shapes remain identical — only token ids
 *   differ, so the swap is a single-file change.
 */

// ORT session lifecycle is shared with ./onnx-session. The reranker owns the
// ONNX_SLOT_RERANKER slot, so switching its model releases the old session
// while an ONNX embedder in its own slot stays resident.

type InferenceSession = Awaited<ReturnType<typeof acquireOnnxSession>>;

export type RerankCandidate = {
  id: string;
  content: string;
};

export type RerankResult = RerankCandidate & {
  /** Relevance score 0–1 (sigmoid of the raw logit). */
  rerankScore: number;
};

// ── ORT session lifecycle ──────────────────────────────────────────────────
// Shared with ./onnx-session (the ONNX_SLOT_RERANKER slot).

/**
 * Create options specific to the cross-encoder: sequential execution is
 * mandatory (ort#23282 — parallel mode is 15× slower for this architecture).
 */
const RERANKER_CREATE_OPTIONS: Record<string, unknown> = {
  executionMode: "sequential",
};

/** Force-release the reranker's ONNX session immediately (on model change
 * or shutdown). No-op when no session is loaded. */
export async function releaseReranker(): Promise<void> {
  await releaseOnnxSession(ONNX_SLOT_RERANKER);
}

// ── Tokenization (real tokenizer.json reader) ────────────────────────────────

const rerankerTokenizerCache = new Map<string, Tokenizer>();

/** Clears the tokenizer cache — test hook for module isolation. */
export function clearTokenizerCacheForTest(): void {
  rerankerTokenizerCache.clear();
}

function getRerankerTokenizer(modelPath: string): Tokenizer {
  let t = rerankerTokenizerCache.get(modelPath);
  if (!t) {
    t = loadTokenizer(modelPath);
    rerankerTokenizerCache.set(modelPath, t);
  }
  return t;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Request timeout for remote rerank API calls. */
const RERANK_REMOTE_TIMEOUT_MS = 15_000;

/**
 * Re-ranks `candidates` against `query`.
 *
 * Automatically dispatches to local ONNX or a remote OpenAI-compatible
 * `/v1/rerank` endpoint based on the saved configuration. Falls back
 * gracefully (returns `null`, preserving RRF order) when:
 *  - Reranker is disabled
 *  - No model/endpoint is configured
 *  - The session fails to load or the request fails
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[] | null> {
  if (!isRerankerEnabled()) return null;
  if (candidates.length === 0) return [];

  let config: ResolvedRerankerConfig | null;
  try {
    config = await resolveRerankerConfig();
  } catch (err) {
    syslog(
      "warn",
      "reranker",
      `Config resolution failed, skipping rerank: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
  if (!config) return null;

  if (config.kind === "openai-compatible") {
    return rerankRemote(config, query, candidates);
  }
  return rerankOnnx(config, query, candidates);
}

/**
 * Re-rank via a remote OpenAI-compatible `/v1/rerank` endpoint.
 *
 * Uses the standard rerank API format accepted by NVIDIA NIM, Together,
 * Cohere, and other OpenAI-compatible providers.
 */
async function rerankRemote(
  config: Exclude<ResolvedRerankerConfig, { kind: "onnx" }>,
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[] | null> {
  const url = `${normalizeEmbeddingBaseUrl(config.baseUrl)}/rerank`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const documents = candidates.map((c) => c.content);
  let data: unknown;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        query,
        documents,
        top_k: candidates.length,
        return_documents: false,
      }),
      signal: AbortSignal.timeout(RERANK_REMOTE_TIMEOUT_MS),
    });

    if (!response.ok) {
      syslog(
        "warn",
        "reranker",
        `Remote reranker returned ${response.status}: ${response.statusText}`
      );
      return null;
    }
    data = await response.json();
  } catch (err) {
    syslog(
      "warn",
      "reranker",
      `Remote reranker request failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const results = parseRerankResponse(data, candidates);
  if (results.length === 0) {
    syslog("warn", "reranker", "Remote reranker returned no results");
    return null;
  }
  return results;
}

/**
 * Parse a reranker API response into RerankResult[].
 * Handles the OpenAI-compatible /v1/rerank response shape:
 *   { data: [{ index, score, ... }, ...] }
 */
function parseRerankResponse(
  data: unknown,
  candidates: RerankCandidate[]
): RerankResult[] {
  if (typeof data !== "object" || data === null) return [];

  const record = data as Record<string, unknown>;
  const dataArr = record.data;
  if (!Array.isArray(dataArr)) return [];

  const results: RerankResult[] = [];
  for (const item of dataArr) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const index = typeof entry.index === "number" ? entry.index : -1;
    const score = typeof entry.score === "number" ? entry.score : undefined;
    if (index < 0 || index >= candidates.length || score === undefined) continue;
    const candidate = candidates[index];
    results.push({
      id: candidate?.id ?? "",
      content: candidate?.content ?? "",
      rerankScore: score,
    });
  }
  return results;
}

/**
 * Re-ranks using a local ONNX cross-encoder (bge-reranker-v2-m3 INT8).
 * Internal implementation for the `onnx` provider branch of `rerankCandidates`.
 */
async function rerankOnnx(
  config: Exclude<ResolvedRerankerConfig, { kind: "openai-compatible" }>,
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[] | null> {
  const modelPath = config.modelPath;
  if (!modelPath) return null;

  let session: InferenceSession;
  try {
    session = await acquireOnnxSession(
      ONNX_SLOT_RERANKER,
      modelPath,
      RERANKER_CREATE_OPTIONS,
      config.idleTimeoutMs
    );
  } catch (err) {
    syslog(
      "warn",
      "reranker",
      `Session unavailable, skipping rerank: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  let ort: OrtModule;
  try {
    ort = await loadOrt();
  } catch (err) {
    syslog(
      "warn",
      "reranker",
      `ORT module unavailable, cannot build tensors: ${err instanceof Error ? err.message : String(err)}`
    );
    await releaseOnnxSession(ONNX_SLOT_RERANKER);
    return null;
  }

  try {
    const results: RerankResult[] = [];

    // Score each (query, doc) pair. Batch size = 1 per pair to keep
    // activation memory bounded regardless of candidate count.
    for (const candidate of candidates) {
      const tokenizer = getRerankerTokenizer(modelPath);
      const { inputIds, attentionMask } = tokenizer.encode(`${query} ${candidate.content}`, 512);
      const seqLen = inputIds.length;

      const feeds: Record<string, unknown> = {
        input_ids: new ort.Tensor(
          "int64",
          BigInt64Array.from(inputIds, BigInt),
          [1, seqLen]
        ),
        attention_mask: new ort.Tensor(
          "int64",
          BigInt64Array.from(attentionMask, BigInt),
          [1, seqLen]
        ),
      };

      const runStart = performance.now();
      const output = await session.run(feeds);
      recordInferenceLatency(ONNX_SLOT_RERANKER, performance.now() - runStart);
      // logits shape: [1, 1] or [1, 2] depending on export; take [0][0].
      const logitData = output.logits?.data as Float32Array | undefined;
      const logit = logitData?.[0] ?? 0;
      const score = 1 / (1 + Math.exp(-logit)); // sigmoid → [0, 1]

      results.push({ ...candidate, rerankScore: score });
    }

    results.sort((a, b) => b.rerankScore - a.rerankScore);
    return results;
  } catch (err) {
    syslog(
      "error",
      "reranker",
      `Rerank inference failed: ${err instanceof Error ? err.message : String(err)}`
    );
    // Release the likely-broken session so the next call gets a fresh one.
    await releaseOnnxSession(ONNX_SLOT_RERANKER);
    return null;
  }
}

/** True when the reranker is configured and the session is currently loaded. */
export function isRerankerLoaded(): boolean {
  return isOnnxSessionLoaded(ONNX_SLOT_RERANKER);
}
