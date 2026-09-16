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

/**
 * Canonical directory where ONNX reranker models are placed.
 */
export const CANONICAL_RERANKER_DIR = path.resolve(
  process.cwd(),
  "data/models/reranker"
);

/**
 * Canonical location for the default INT8 quantized model.
 * If present and ≥ 50 MB, the reranker activates automatically with zero
 * environment variable configuration.
 */
export const CANONICAL_MODEL_PATH = path.join(
  CANONICAL_RERANKER_DIR,
  "bge-reranker-v2-m3-int8.onnx"
);

export const DEFAULT_RERANKER_FILENAME = "bge-reranker-v2-m3-int8.onnx";

/** Minimum byte length for an ONNX model file (~50MB) to reject stubs/404s. */
const MIN_MODEL_SIZE_BYTES = 50 * 1024 * 1024;

export type RerankerDbSetting = {
  enabled?: boolean;
  selectedModel?: string;
  idleTimeoutMinutes?: number;
};

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
 * `DiscoveredModel` shape onto `DiscoveredRerankerModel` (re-deriving
 * `isDefault` from the filename). The `customDiscoveredModelsResolver`
 * test hook is preserved so existing reranker tests are unaffected.
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
    isDefault: path.basename(m.filename) === DEFAULT_RERANKER_FILENAME,
  }));
  models.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    return a.filename.localeCompare(b.filename);
  });
  return models;
}

function isValidModelFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size >= MIN_MODEL_SIZE_BYTES;
  } catch {
    return false;
  }
}

/**
 * Resolves the path to the reranker model file:
 * 1. customModelPathResolver if active (unit test hook).
 * 2. User-configured selectedModel in database settings (settings table key "reranker").
 * 3. env.RERANKER_MODEL_PATH if specified and valid.
 * 4. First discovered model from CANONICAL_RERANKER_DIR (auto-discovery).
 * 5. CANONICAL_MODEL_PATH if present.
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

  // 3. First discovered model in CANONICAL_RERANKER_DIR
  const discovered = discoverRerankerModels();
  if (discovered.length > 0) {
    return discovered[0].path;
  }

  // 4. CANONICAL_MODEL_PATH if present
  if (isValidModelFile(CANONICAL_MODEL_PATH)) {
    return CANONICAL_MODEL_PATH;
  }

  return null;
}

export type RerankerStatus = {
  enabled: boolean;
  available: boolean;
  loaded: boolean;
  modelPath: string | null;
  sizeBytes?: number;
  canonicalPath: string;
  mode: "active" | "standby" | "fallback" | "disabled";
  discoveredModels: Array<{ filename: string; sizeBytes: number }>;
  telemetry?: OnnxTelemetry | null;
};

/** Reports current diagnostic status of the neural reranker system. */
export function getRerankerStatus(): RerankerStatus {
  const resolvedPath = resolveRerankerModelPath();
  const enabled = isRerankerEnabled();
  const loaded = isRerankerLoaded();
  const discovered = discoverRerankerModels();
  const discoveredModels = discovered.map((m) => ({
    filename: m.filename,
    sizeBytes: m.sizeBytes,
  }));
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
        sizeBytes = fs.statSync(resolvedPath).size;
      } catch {
        // non-fatal
      }
    }
  }
  return {
    enabled,
    available: resolvedPath !== null,
    loaded,
    modelPath: resolvedPath,
    sizeBytes,
    canonicalPath: CANONICAL_MODEL_PATH,
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

/**
 * Re-ranks `candidates` against `query` using bge-reranker-v2-m3 ONNX INT8.
 *
 * Called post-RRF in `hybridMemorySearch` on the top-`RERANKER_CANDIDATE_WINDOW`
 * results before slicing to `limit`. Falls back gracefully when:
 *  - RERANKER_ENABLED is false
 *  - RERANKER_MODEL_PATH is unset or the file is missing
 *  - onnxruntime-node is not installed
 *  - The session fails to load (e.g. unsupported platform)
 *
 * In all failure modes, the caller's original RRF ranking is preserved.
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankCandidate[]
): Promise<RerankResult[] | null> {
  if (!isRerankerEnabled()) return null;
  const modelPath = resolveRerankerModelPath();
  if (!modelPath) return null;
  if (candidates.length === 0) return [];

  let session: InferenceSession;
  try {
    session = await acquireOnnxSession(
      ONNX_SLOT_RERANKER,
      modelPath,
      RERANKER_CREATE_OPTIONS,
      resolveRerankerIdleTimeoutMs()
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
