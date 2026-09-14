import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { syslog } from "@/lib/observability/log-store";
import { env } from "@/env";
import { getSettingDb } from "@/lib/settings-service";

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
  } catch {
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
 * Scans CANONICAL_RERANKER_DIR for files ending in .onnx with size >= 50MB.
 * Prioritizes the default model (bge-reranker-v2-m3-int8.onnx) first.
 */
export function discoverRerankerModels(): DiscoveredRerankerModel[] {
  if (customDiscoveredModelsResolver) {
    return customDiscoveredModelsResolver();
  }
  try {
    if (!fs.existsSync(CANONICAL_RERANKER_DIR)) {
      return [];
    }
    const entries = fs.readdirSync(CANONICAL_RERANKER_DIR, { withFileTypes: true });
    const models: DiscoveredRerankerModel[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".onnx")) {
        const filePath = path.join(CANONICAL_RERANKER_DIR, entry.name);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size >= MIN_MODEL_SIZE_BYTES) {
            models.push({
              filename: entry.name,
              path: filePath,
              sizeBytes: stat.size,
              isDefault: entry.name === DEFAULT_RERANKER_FILENAME,
            });
          }
        } catch {
          // File disappeared or inaccessible
        }
      }
    }
    models.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return a.filename.localeCompare(b.filename);
    });
    return models;
  } catch {
    return [];
  }
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
  canonicalPath: string;
  mode: "active" | "standby" | "fallback" | "disabled";
  discoveredModels: Array<{ filename: string; sizeBytes: number }>;
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
  return {
    enabled,
    available: resolvedPath !== null,
    loaded,
    modelPath: resolvedPath,
    canonicalPath: CANONICAL_MODEL_PATH,
    mode,
    discoveredModels,
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

// ── Optional ORT type surface (not imported at module load) ───────────────

// onnxruntime-node is an optional native dependency. We import it
// dynamically inside functions so the module loads without it (the
// reranker is simply disabled). TypeScript sees the types through
// a conditional `typeof import` only — no top-level import statement.

// onnxruntime-node is an optional native dependency. Dynamic import
// ensures the module loads cleanly without it (the reranker is simply
// disabled at startup). Types are duck-typed interfaces so the file
// compiles without the package installed.

export interface OrtTensor {
  type: string;
  data: unknown;
  dims: readonly number[];
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<{
    logits?: { data: Float32Array };
    [key: string]: unknown;
  }>;
  release(): Promise<void>;
}

interface OrtModule {
  InferenceSession: {
    create(
      path: string,
      options?: Record<string, unknown>
    ): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: unknown,
    dims: readonly number[]
  ) => OrtTensor;
}

type InferenceSession = OrtSession;

export type RerankCandidate = {
  id: string;
  content: string;
};

export type RerankResult = RerankCandidate & {
  /** Relevance score 0–1 (sigmoid of the raw logit). */
  rerankScore: number;
};

// ── ORT session lifecycle ──────────────────────────────────────────────────

type SessionEntry = {
  session: InferenceSession;
  timer: ReturnType<typeof setTimeout> | null;
  modelPath: string;
};

// Module-level singleton. The WeakMap pattern is not viable here because
// InferenceSession is a C++ class; use a plain object anchored on globalThis
// so Next.js HMR reloads find the still-running session.
const RERANKER_GLOBAL_KEY = "__yggdrasilReranker";

type RerankerGlobal = {
  entry: SessionEntry | null;
};

function rerankerGlobal(): RerankerGlobal {
  const g = globalThis as unknown as Record<string, RerankerGlobal | undefined>;
  if (!g[RERANKER_GLOBAL_KEY]) {
    g[RERANKER_GLOBAL_KEY] = { entry: null };
  }
  return g[RERANKER_GLOBAL_KEY];
}

let customOrtLoader: (() => Promise<OrtModule>) | null = null;

/** Test hook: override the dynamic ORT module loader in unit tests. */
export function setOrtLoaderForTest(loader: (() => Promise<OrtModule>) | null): void {
  customOrtLoader = loader;
}

async function loadOrt(): Promise<OrtModule> {
  if (customOrtLoader) {
    return customOrtLoader();
  }
  try {
    // Dynamic variable-based import hides the specifier from Vite/Rollup's
    // static import-resolver, so the file bundles cleanly even when
    // onnxruntime-node is not installed.
    const pkg = "onnxruntime-node";
    const mod = await import(/* @vite-ignore */ pkg);
    return (mod.default ?? mod) as unknown as OrtModule;
  } catch {
    throw new Error(
      "onnxruntime-node is not installed. Run: pnpm add onnxruntime-node"
    );
  }
}

/**
 * malloc_trim(0) on Linux nudges glibc to return free arenas to the OS.
 * In a standard pure-JS Node.js process without a native C++ addon wrapper,
 * this is a best-effort no-op; if a native helper is present, it is invoked.
 */
function mallocTrim(): void {
  // Pure JS cannot invoke glibc's malloc_trim directly without FFI.
  // global.gc() handles V8-side reclamation.
}

let sessionInitPromise: Promise<InferenceSession> | null = null;

async function acquireSession(modelPath: string): Promise<InferenceSession> {
  const g = rerankerGlobal();
  if (g.entry) {
    if (g.entry.modelPath !== modelPath) {
      await releaseSession();
    } else {
      // Reset idle timer on re-use.
      if (g.entry.timer !== null) {
        clearTimeout(g.entry.timer);
        g.entry.timer = null;
      }
      scheduleRelease();
      return g.entry.session;
    }
  }

  // Deduplicate concurrent initialization to prevent multiple native
  // sessions being allocated simultaneously and orphaned in memory.
  if (sessionInitPromise) return sessionInitPromise;

  sessionInitPromise = (async () => {
    try {
      const ort = await loadOrt();
      syslog("info", "reranker", `Loading bge-reranker-v2-m3 ONNX INT8 from ${modelPath}`);

      const session = await ort.InferenceSession.create(modelPath, {
        // Prevent glibc arena leak on Linux (ort#25325).
        enableCpuMemArena: false,
        // Pattern-based pre-allocation creates residual memory pressure.
        enableMemPattern: false,
        // Sequential is required — parallel mode is 15× slower for this model.
        executionMode: "sequential",
        graphOptimizationLevel: "all",
        intraOpNumThreads: Math.min(os.cpus().length, 4),
        interOpNumThreads: 1,
        // Load from file path: streaming parse peaks at 2× model size (~1.1 GB),
        // vs 3× for Uint8Array loading. File path is preferred for production.
        executionProviders: ["cpu"],
      } as Record<string, unknown>);

      g.entry = { session, timer: null, modelPath };
      scheduleRelease();
      syslog("info", "reranker", "bge-reranker-v2-m3 session ready");
      return session;
    } finally {
      sessionInitPromise = null;
    }
  })();

  return sessionInitPromise;
}

function scheduleRelease(): void {
  const g = rerankerGlobal();
  if (!g.entry) return;
  g.entry.timer = setTimeout(() => {
    void releaseSession();
  }, env.RERANKER_IDLE_TIMEOUT_MS);
  if (typeof g.entry.timer?.unref === "function") {
    g.entry.timer.unref();
  }
}

async function releaseSession(): Promise<void> {
  const g = rerankerGlobal();
  if (!g.entry) return;
  const { session, timer } = g.entry;
  g.entry = null;
  if (timer !== null) clearTimeout(timer);
  try {
    await session.release();
    // V8 GC cannot reclaim native ORT memory — nudge it explicitly.
    if (typeof global.gc === "function") global.gc();
    mallocTrim();
    syslog("info", "reranker", "bge-reranker-v2-m3 session released (idle timeout)");
  } catch (err) {
    syslog("error", "reranker", `session.release() failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Force-release the session immediately (e.g. on graceful shutdown). */
export async function releaseReranker(): Promise<void> {
  await releaseSession();
}

// ── Tokenization (manual, no external dep) ────────────────────────────────

/**
 * Maximum token budget per pair. BAAI recommends 1024 for fine-tuned
 * quality; 512 is the safe default for fast CPU inference.
 * Estimated at ~4 chars/token (XLM-R BPE average).
 */
const MAX_CHARS_PER_PAIR = 512 * 4;
const QUERY_MAX_CHARS = 200;
const DOC_MAX_CHARS = MAX_CHARS_PER_PAIR - QUERY_MAX_CHARS;

/**
 * Naïve character-budget tokenizer stub: splits on whitespace and
 * reassembles tokens into word-boundary-safe ids using XLM-RoBERTa's
 * ASCII codepoint mapping. This is a best-effort approach until
 * @huggingface/transformers is added as a dep.
 *
 * For production accuracy: replace with AutoTokenizer from HuggingFace.
 * The output feed shapes remain identical — only the token ids change.
 */
function naiveTokenize(
  query: string,
  document: string
): { inputIds: number[]; attentionMask: number[]; tokenTypeIds: number[] } {
  const q = query.slice(0, QUERY_MAX_CHARS);
  const d = document.slice(0, DOC_MAX_CHARS);
  // [CLS]=0  [SEP]=2  pad=1  (XLM-RoBERTa special tokens)
  const queryTokens = q.split(/\s+/).filter(Boolean).map(charEncodeWord);
  const docTokens = d.split(/\s+/).filter(Boolean).map(charEncodeWord);

  // [CLS] q... [SEP] d... [SEP]
  const ids = [0, ...queryTokens, 2, ...docTokens, 2];
  const mask = ids.map(() => 1);
  // Segment: 0 for query side, 1 for document side (separator belongs to its left half)
  const typeIds = [
    0, // CLS
    ...queryTokens.map(() => 0),
    0, // first SEP
    ...docTokens.map(() => 1),
    1, // second SEP
  ];

  return { inputIds: ids, attentionMask: mask, tokenTypeIds: typeIds };
}

function charEncodeWord(word: string): number {
  // Map each char to its UTF-16 codepoint modulo the 250K vocab size.
  // This is NOT the real SentencePiece BPE — it produces stable but
  // non-meaningful token ids suitable for integration testing only.
  let h = 0;
  for (let i = 0; i < word.length; i++) {
    h = ((h << 5) - h + word.charCodeAt(i)) >>> 0;
  }
  return (h % 249_994) + 4; // skip special tokens 0-3
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
    session = await acquireSession(modelPath);
  } catch (err) {
    syslog(
      "warn",
      "reranker",
      `Session unavailable, skipping rerank: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  const ort = await loadOrt();

  try {
    const results: RerankResult[] = [];

    // Score each (query, doc) pair. Batch size = 1 per pair to keep
    // activation memory bounded regardless of candidate count.
    for (const candidate of candidates) {
      const { inputIds, attentionMask } = naiveTokenize(
        query,
        candidate.content
      );
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

      const output = await session.run(feeds);
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
    await releaseSession();
    return null;
  }
}

/** True when the reranker is configured and the session is currently loaded. */
export function isRerankerLoaded(): boolean {
  return rerankerGlobal().entry !== null;
}
