import { getSettingDb } from "@/lib/settings-service";
import { stripStraySseTail } from "@/lib/ai/provider";
import { loadRegistry, resolveApiKey } from "@/lib/ai/provider-config/store";
// Circular-safe: store.ts imports CANONICAL_EMBEDDING_DIR from here, but only
// reads it inside functions (never at module-init time). discoverModels is
// invoked at runtime when this wrapper is called, by which point the const
// is initialized.
import { discoverModels } from "@/lib/models/store";

/**
 * Embedding engine for the memory system.
 *
 * Provider routing (provider registry — see lib/ai/provider-config):
 *  - "server"            — the registry's "server" provider entry
 *  - "openai-compatible" — any cloud/self-hosted /embeddings endpoint
 *  - "ollama"            — local Ollama via its native /api/embed endpoint
 *  - "onnx"              — on-device ONNX model (lazy-loaded, mirrors reranker)
 *
 * The legacy SQLite-backed getEmbeddingConfig() remains exported for the
 * settings route until Task 5 migrates it.
 *
 * Long text is split into overlapping chunks (industry default ≈512
 * tokens with 10-20% overlap), each chunk is embedded, and the chunks
 * are mean-pooled into one L2-normalized vector per memory. When no
 * endpoint is reachable, a deterministic 64-dim hash vector keeps the
 * pipeline functional offline.
 */

export type EmbeddingProviderKind = "server" | "openai-compatible" | "ollama" | "onnx";

export type EmbeddingConfig = {
  provider: EmbeddingProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** ONNX model file (absolute path or filename in the embedding model dir). */
  modelPath?: string;
  /** Pooling mode for a token-level ONNX output; absent = auto-resolve. */
  poolingMode?: PoolingMode;
  /** Auto-detected native vector length of the configured model. */
  dimensions?: number;
  /** Chunk size in characters (≈4 chars per token). */
  chunkSize: number;
  /** Overlap between consecutive chunks in characters. */
  chunkOverlap: number;
};

/** ≈512 tokens at ~4 chars/token — the common retrieval sweet spot. */
export const DEFAULT_CHUNK_SIZE = 2000;
/** 10% of the default chunk size (recommended range: 10-20%). */
export const DEFAULT_CHUNK_OVERLAP = 200;

export const MIN_CHUNK_SIZE = 200;
export const MAX_CHUNK_SIZE = 20000;

import { env } from "@/env";
import { syslog } from "@/lib/observability/log-store";

export const DEFAULT_OPENAI_MODEL_ID = "text-embedding-3-small";
export const DEFAULT_OLLAMA_MODEL_ID = "nomic-embed-text";
export const EMBEDDING_FETCH_TIMEOUT_MS = env.EMBEDDING_FETCH_TIMEOUT_MS;

/** Pick the standard fallback model for a provider when none is configured. */
export function getDefaultModelForProvider(
  provider: EmbeddingProviderKind
): string {
  if (provider === "onnx") {
    return "onnx";
  }
  return provider === "ollama" ? DEFAULT_OLLAMA_MODEL_ID : DEFAULT_OPENAI_MODEL_ID;
}

// ── ONNX embedding provider (mirrors reranker lifecycle) ────────────────────

import fs from "node:fs";
import path from "node:path";
import {
  acquireOnnxSession,
  releaseOnnxSession,
  isOnnxSessionLoaded,
  loadOrt,
  ONNX_SLOT_EMBEDDING,
  type OrtModule,
} from "./onnx-session";
import { loadTokenizer, type Tokenizer } from "./tokenizer";
import {
  resolvePoolingMode,
  poolTokenEmbeddings,
  type PoolingMode,
} from "./pooling";

/** Canonical directory scanned for local ONNX embedding models. */
export const CANONICAL_EMBEDDING_DIR = path.resolve(
  process.cwd(),
  env.EMBEDDING_ONNX_DIR ?? "data/models/embedding"
);

/** Minimum byte length for an ONNX model file (~10 MB) to reject stubs/404s. */
const MIN_ONNX_MODEL_SIZE_BYTES = 10 * 1024 * 1024;

/** Model input limit for sentence-embedding checkpoints (BERT-family default). */
const MAX_EMBEDDING_TOKENS = 512;

/**
 * Cheap pre-trim before tokenizing (~4 chars/token). The tokenizer applies the
 * exact 512-token budget; this only avoids scanning pathological inputs.
 */
const MAX_EMBEDDING_CHARS = MAX_EMBEDDING_TOKENS * 4;

/**
 * Compiled tokenizers, keyed by model path. Parsing tokenizer.json is
 * read-once work; the entry is dropped when the model's file is replaced
 * (a new session load re-reads it). Bounded by the number of local models.
 */
const tokenizerCache = new Map<string, Tokenizer>();

/** Read + compile the model's tokenizer once, then reuse it. */
function loadTokenizerCached(modelPath: string): Tokenizer {
  const cached = tokenizerCache.get(modelPath);
  if (cached) return cached;
  const tokenizer = loadTokenizer(modelPath);
  tokenizerCache.set(modelPath, tokenizer);
  return tokenizer;
}

/** Test hook: drop cached tokenizers between cases. */
export function clearTokenizerCacheForTest(): void {
  tokenizerCache.clear();
}

export type DiscoveredEmbeddingModel = {
  filename: string;
  path: string;
  sizeBytes: number;
};

/**
 * The effective byte size of an ONNX model. Large models are exported with
 * weights in a sibling `<file>_data` file (ONNX external-data format), leaving
 * the `.onnx` graph itself only a few hundred KB — BGE-m3 is 607 KB of graph
 * plus a multi-GB `model.onnx_data`. Measuring only the graph would reject
 * every such model, so the external file is counted when present.
 */
function onnxModelSizeBytes(filePath: string): number {
  let total = 0;
  try {
    total = fs.statSync(filePath).size;
  } catch {
    return 0;
  }
  // ONNX external-data naming: `<name>.onnx` → `<name>.onnx_data`.
  try {
    total += fs.statSync(`${filePath}_data`).size;
  } catch {
    // No external data — the graph is self-contained.
  }
  return total;
}

/** A valid ONNX model: a file whose effective size clears the stub threshold. */
function isValidOnnxFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  return onnxModelSizeBytes(filePath) >= MIN_ONNX_MODEL_SIZE_BYTES;
}

/**
 * Discover locally installed embedding models via the shared model store.
 *
 * Delegates to `store.discoverModels("embedding")`, which scans
 * `data/models/embedding/` for manifested subdirectories and legacy flat
 * `.onnx` files. Returns only the `DiscoveredEmbeddingModel` shape
 * (`{ filename, path, sizeBytes }`) to preserve the existing contract.
 */
export function discoverEmbeddingModels(): DiscoveredEmbeddingModel[] {
  return discoverModels("embedding").map((m) => ({
    filename: m.filename,
    path: m.path,
    sizeBytes: m.sizeBytes,
  }));
}

/**
 * Resolve the ONNX embedding model path:
 * 1. Absolute modelPath from config (if valid).
 * 2. Relative modelPath resolved inside CANONICAL_EMBEDDING_DIR (if valid).
 * 3. First discovered model in CANONICAL_EMBEDDING_DIR.
 * Returns null if no valid model file exists on disk.
 */

export function resolveEmbeddingOnnxPath(
  modelPath?: string
): string | null {
  if (modelPath) {
    const candidate = path.isAbsolute(modelPath)
      ? modelPath
      : path.join(CANONICAL_EMBEDDING_DIR, modelPath);
    if (isValidOnnxFile(candidate)) return candidate;
  }

  const discovered = discoverEmbeddingModels();
  if (discovered.length > 0) return discovered[0].path;

  return null;
}

/** Diagnostic status for the ONNX embedding provider. */
export type OnnxEmbeddingStatus = {
  /** The model path that would be used (null if no valid file on disk). */
  modelPath: string | null;
  /** Whether a session is currently loaded in memory. */
  loaded: boolean;
  /** All discovered models on disk, for the settings dropdown. */
  discoveredModels: Array<{ filename: string; sizeBytes: number }>;
  /**
   * Pooling mode in effect. "already-pooled" means the graph emits a sentence
   * vector itself; "unresolved" means the UI must ask (the model declares no
   * mode and none is saved).
   */
  pooling:
    | { status: "already-pooled" }
    | { status: "resolved"; mode: PoolingMode; source: string }
    | { status: "unresolved" };
};

export function getOnnxEmbeddingStatus(
  modelPath?: string,
  explicitPoolingMode?: PoolingMode
): OnnxEmbeddingStatus {
  const resolved = resolveEmbeddingOnnxPath(modelPath);
  const discovered = discoverEmbeddingModels();

  // Pooling can only be resolved once a model is on disk. Report the saved
  // choice first (tier 3) so the UI shows what will actually be used.
  let pooling: OnnxEmbeddingStatus["pooling"] = { status: "unresolved" };
  if (resolved) {
    if (explicitPoolingMode) {
      pooling = {
        status: "resolved",
        mode: explicitPoolingMode,
        source: "configured",
      };
    } else {
      // Check manifest first (stores the real smoke-tested pooling mode, e.g. already-pooled)
      const allDiscovered = discoverModels("embedding");
      const matched = allDiscovered.find((m) => m.path === resolved);
      if (matched?.poolingMode) {
        pooling =
          matched.poolingMode === "already-pooled"
            ? { status: "already-pooled" }
            : {
                status: "resolved",
                mode: matched.poolingMode as PoolingMode,
                source: "sidecar",
              };
      } else {
        const resolution = resolvePoolingMode(resolved, [1, 0, 0]);
        pooling =
          resolution.kind === "already-pooled"
            ? { status: "already-pooled" }
            : resolution.kind === "resolved"
              ? {
                  status: "resolved",
                  mode: resolution.mode,
                  source: resolution.source,
                }
              : { status: "unresolved" };
      }
    }
  }

  return {
    modelPath: resolved,
    loaded: isOnnxSessionLoaded(ONNX_SLOT_EMBEDDING),
    discoveredModels: discovered.map((m) => ({
      filename: m.filename,
      sizeBytes: m.sizeBytes,
    })),
    pooling,
  };
}

/** Short neutral text used for dimension probes. */
const PROBE_TEXT = "Yggdrasil embedding dimension probe";

/**
 * In-memory LRU cache for short text embeddings (e.g. chat query embeddings).
 * Prevents redundant HTTP calls during repeated or similar user queries.
 * Bounded to 200 entries to prevent memory leaks (Rule 02 & Rule 17).
 */
const MAX_EMBEDDING_CACHE_ENTRIES = 200;
const embeddingLruCache = new Map<string, Float32Array>();

export function clearEmbeddingCacheForTest(): void {
  embeddingLruCache.clear();
}

function getCacheKey(endpoint: ResolvedEndpoint, model: string, text: string): string {
  const locator = endpoint.kind === "onnx" ? endpoint.modelPath : endpoint.baseUrl;
  // The pooling mode is part of the identity: the same text under cls vs mean
  // yields different vectors, so a cached one must never be served for the
  // other.
  const pooling = endpoint.kind === "onnx" ? (endpoint.poolingMode ?? "auto") : "";
  return `${endpoint.kind}:${locator ?? ""}:${pooling}:${model}:${text}`;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return new Float32Array(arrayBuffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Read the saved embedding configuration with safe defaults applied.
 * Missing/corrupt settings fall back to the "server" provider.
 *
 * @deprecated Legacy SQLite-backed config — the settings route's last
 * consumer until Task 5 migrates it. New code uses
 * getEmbeddingConfigFromRegistry().
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  let stored: Record<string, unknown> = {};
  try {
    const raw = getSettingDb("embedding");
    if (typeof raw === "object" && raw !== null) {
      stored = raw as Record<string, unknown>;
    }
  } catch (err) {
    syslog("warn", "embeddings", `Failed to read embedding settings: ${err instanceof Error ? err.message : String(err)}`);
  }

  const provider: EmbeddingProviderKind =
    stored.provider === "ollama" ||
    stored.provider === "openai-compatible" ||
    stored.provider === "onnx"
      ? stored.provider
      : "server";

  const chunkSize = clampInt(
    stored.chunkSize,
    MIN_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
    DEFAULT_CHUNK_SIZE
  );
  const chunkOverlap = clampInt(
    stored.chunkOverlap,
    0,
    Math.floor(chunkSize / 2),
    Math.min(DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 2))
  );

  return {
    provider,
    baseUrl:
      typeof stored.baseUrl === "string" && stored.baseUrl
        ? stored.baseUrl
        : undefined,
    apiKey:
      typeof stored.apiKey === "string" && stored.apiKey
        ? stored.apiKey
        : undefined,
    model:
      typeof stored.model === "string" && stored.model.trim()
        ? stored.model.trim()
        : undefined,
    modelPath:
      typeof stored.modelPath === "string" && stored.modelPath.trim()
        ? stored.modelPath.trim()
        : undefined,
    dimensions:
      typeof stored.dimensions === "number" && stored.dimensions > 0
        ? Math.round(stored.dimensions)
        : undefined,
    chunkSize,
    chunkOverlap,
  };
}

/**
 * Read the embedding configuration from the provider registry. Throws
 * ProviderConfigError when the registry is missing/corrupt — callers
 * that must not throw (generateEmbedding, stats) catch and degrade.
 *
 * Resolution order:
 *  1. embedding.provider === "onnx" → local ONNX model path (self-contained,
 *     no baseUrl/providerId needed).
 *  2. embedding.providerId set → that provider entry supplies baseUrl +
 *     apiKey (kind "ollama" → provider "ollama", else "openai-compatible").
 *  3. providerId null → standalone block: inline baseUrl + apiKeyEnv
 *     (an http(s) baseUrl means "openai-compatible", otherwise "server").
 *  4. No embedding block → "server" provider entry, else bare "server"
 *     with no endpoint (resolveEndpoint then returns null).
 */
export async function getEmbeddingConfigFromRegistry(): Promise<EmbeddingConfig> {
  const doc = await loadRegistry();
  const embedding = doc.embedding;

  // Clamp defaults are computed from the block's own chunk fields so the
  // invariants of the legacy path (overlap ≤ ⌊size/2⌋) keep holding.
  const rawSize =
    typeof embedding?.chunkSize === "number" ? embedding.chunkSize : undefined;
  const rawOverlap =
    typeof embedding?.chunkOverlap === "number"
      ? embedding.chunkOverlap
      : undefined;
  const chunkSize = clampInt(
    rawSize,
    MIN_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
    DEFAULT_CHUNK_SIZE
  );
  const chunkOverlap = clampInt(
    rawOverlap,
    0,
    Math.floor(chunkSize / 2),
    Math.min(DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 2))
  );

  // 1. ONNX provider: self-contained model path, no registry endpoint needed.
  if (embedding?.provider === "onnx" && embedding?.modelPath) {
    return {
      provider: "onnx",
      modelPath: embedding.modelPath,
      poolingMode: embedding.poolingMode,
      model: embedding.model,
      dimensions: embedding.dimensions,
      chunkSize,
      chunkOverlap,
    };
  }

  if (embedding?.providerId != null) {
    const entry = doc.providers.find((p) => p.id === embedding.providerId);
    if (entry) {
      return {
        provider: entry.kind === "ollama" ? "ollama" : "openai-compatible",
        baseUrl: entry.baseUrl,
        apiKey: await resolveApiKey(entry),
        model: embedding.model,
        dimensions: embedding.dimensions,
        chunkSize,
        chunkOverlap,
      };
    }
  }

  // Standalone block: inline baseUrl + apiKeyEnv. The kind is unknowable
  // from a bare URL, so any absolute base ("://") is treated as
  // "openai-compatible"; anything else degrades to "server".
  if (embedding?.providerId == null && embedding?.baseUrl) {
    return {
      provider: embedding.baseUrl.includes("://")
        ? "openai-compatible"
        : "server",
      baseUrl: embedding.baseUrl,
      apiKey: await resolveApiKey(embedding),
      model: embedding.model,
      dimensions: embedding.dimensions,
      chunkSize,
      chunkOverlap,
    };
  }

  // No embedding block (or a dangling providerId): fall back to the
  // registry's "server" entry; without one, return a bare "server" config
  // with no baseUrl so callers degrade to the "no endpoint" path.
  const server = doc.providers.find((p) => p.id === "server");
  if (server) {
    return {
      provider: "server",
      baseUrl: server.baseUrl,
      apiKey: await resolveApiKey(server),
      model: embedding?.model,
      dimensions: embedding?.dimensions,
      chunkSize,
      chunkOverlap,
    };
  }
  return {
    provider: "server",
    model: embedding?.model,
    dimensions: embedding?.dimensions,
    chunkSize,
    chunkOverlap,
  };
}

/**
 * Split text into overlapping, sentence-aware chunks. Text shorter than
 * chunkSize returns a single chunk. Overlap keeps boundary sentences
 * from being fragmented (recommended 10-20% of chunk size).
 */
export function chunkText(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  const safeOverlap = Math.min(Math.max(0, overlap), Math.floor(chunkSize / 2));
  const sentences = trimmed.match(/[^.!?…\n]+[.!?…]*\s*/g) ?? [trimmed];
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    const chunk = current.trim();
    if (chunk) chunks.push(chunk);
    // Carry the tail forward as overlap for the next chunk.
    current =
      safeOverlap > 0 ? current.slice(-safeOverlap) : "";
  };

  for (const sentence of sentences) {
    if (sentence.length > chunkSize) {
      // Oversized sentence (no punctuation): flush, then hard-window it.
      if (current.trim()) pushCurrent();
      current = "";
      const step = chunkSize - safeOverlap;
      for (let i = 0; i < sentence.length; i += step) {
        const window = sentence.slice(i, i + chunkSize).trim();
        if (window) chunks.push(window);
        if (i + chunkSize >= sentence.length) break;
      }
      continue;
    }
    if (current.length + sentence.length > chunkSize && current.trim()) {
      pushCurrent();
      // Shrink the overlap tail if it alone would overflow with this sentence.
      if (current.length + sentence.length > chunkSize) {
        const remaining = chunkSize - sentence.length;
        current = remaining > 0 ? current.slice(-remaining) : "";
      }
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/** Mean-pool chunk vectors into one L2-normalized vector. */
function meanPool(vectors: Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  let used = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
    used += 1;
  }
  if (used === 0) return out;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    out[i] /= used;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) out[i] /= norm;
  }
  return out;
}

/** OpenAI-compatible POST {base}/embeddings → data[0].embedding. */
async function requestOpenAICompatibleEmbedding(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  text: string
): Promise<Float32Array | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        input: text,
        model,
      }),
      signal: AbortSignal.timeout(EMBEDDING_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      syslog("warn", "embeddings", `Remote embedding request failed with status ${response.status}: ${response.statusText}`);
      return null;
    }

    // The same misbehaving gateway that appends SSE terminators
    // ("data: [DONE]") to non-stream JSON chat responses (fixed in
    // 39a2267 for provider.ts) does it to /embeddings too — strip the
    // tail before JSON.parse so memory vectors are not silently lost.
    const rawBody = await response.text();
    const data = JSON.parse(stripStraySseTail(rawBody)) as {
      data?: Array<{ embedding?: unknown }>;
    };
    const raw = data?.data?.[0]?.embedding;
    if (Array.isArray(raw)) return new Float32Array(raw);
    return null;
  } catch (err) {
    syslog("warn", "embeddings", `Failed to fetch remote embedding: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Extract the sentence vector from an ONNX embedder's output.
 *
 * Two export shapes dominate:
 *  - `sentence_embedding` / `embeddings` / `output` [1, hidden]: already
 *    pooled by the graph — take it as-is.
 *  - `last_hidden_state` / `token_embeddings` [1, seq, hidden]: one vector per
 *    TOKEN. Collapsing these requires the model's pooling mode, which the
 *    graph does not record — see ./pooling for the resolution order.
 *
 * `explicitMode` comes from the saved setting (tier 3). When absent, the mode
 * is auto-resolved from the sidecar config (tier 2). Returns `null` when the
 * output is token-level and no mode could be determined — the caller must not
 * guess, because the wrong pooling yields a plausible vector from the wrong
 * region of embedding space and degrades retrieval silently.
 */
function pickEmbeddingTensor(
  output: Record<string, unknown>,
  seqLen: number,
  attentionMask: readonly number[],
  modelPath: string,
  explicitMode?: PoolingMode
): Float32Array | null {
  const toFloat = (data: unknown): Float32Array | null =>
    data instanceof Float32Array
      ? data
      : Array.isArray(data)
        ? new Float32Array(data as number[])
        : null;

  // A graph that already emits one vector per input needs no pooling.
  const pooledKeys = ["sentence_embedding", "embeddings", "output", "logits"];
  for (const key of pooledKeys) {
    const data = toFloat((output[key] as { data?: unknown } | undefined)?.data);
    if (data && data.length > 0) return data;
  }

  for (const key of ["last_hidden_state", "token_embeddings"]) {
    const flat = toFloat((output[key] as { data?: unknown } | undefined)?.data);
    if (!flat || flat.length === 0) continue;
    const hidden = Math.floor(flat.length / seqLen);
    if (hidden <= 0) continue;

    const mode =
      explicitMode ??
      (() => {
        const resolution = resolvePoolingMode(modelPath, [1, seqLen, hidden]);
        return resolution.kind === "resolved" ? resolution.mode : null;
      })();
    if (!mode) return null;

    return poolTokenEmbeddings(flat, seqLen, hidden, attentionMask, mode);
  }

  return null;
}

/** Scale a vector to unit length; returns it unchanged when the norm is 0. */
function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * ONNX embedding model: load the session (lazy, shared via onnx-session),
 * tokenize the text, run inference, and return the L2-normalized vector.
 *
 * The tokenizer is checked BEFORE the session is acquired: a model without a
 * real tokenizer.json can never produce a meaningful vector, and loading a
 * multi-hundred-MB session only to discard it wastes both time and RSS.
 */
async function requestOnnxEmbedding(
  modelPath: string,
  text: string,
  explicitPoolingMode?: PoolingMode
): Promise<Float32Array | null> {
  let tokenizer: Tokenizer;
  try {
    tokenizer = loadTokenizerCached(modelPath);
  } catch (err) {
    // Refusing here is deliberate: hashing words into arbitrary ids would
    // yield numerically valid but semantically meaningless vectors and
    // silently corrupt every cosine/KNN lookup downstream.
    syslog(
      "warn",
      "embeddings",
      `ONNX tokenizer unavailable, memory will be stored without a vector: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  let session;
  try {
    session = await acquireOnnxSession(
      ONNX_SLOT_EMBEDDING,
      modelPath,
      undefined,
      env.EMBEDDING_ONNX_IDLE_TIMEOUT_MS
    );
  } catch (err) {
    syslog(
      "warn",
      "embeddings",
      `ONNX session unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  let ort: OrtModule;
  try {
    ort = await loadOrt();
  } catch (err) {
    syslog(
      "warn",
      "embeddings",
      `ORT module unavailable: ${err instanceof Error ? err.message : String(err)}`
    );
    await releaseOnnxSession(ONNX_SLOT_EMBEDDING);
    return null;
  }

  try {
    const { inputIds, attentionMask } = tokenizer.encode(
      text.slice(0, MAX_EMBEDDING_CHARS),
      MAX_EMBEDDING_TOKENS
    );
    const seqLen = inputIds.length;

    // Build feeds from what the GRAPH declares. Exports differ: BERT-family
    // models require token_type_ids (all zeros for single-sequence input)
    // while RoBERTa-family models must NOT receive it — passing an undeclared
    // input, or omitting a declared one, fails at session.run().
    const ids = BigInt64Array.from(inputIds, BigInt);
    const mask = BigInt64Array.from(attentionMask, BigInt);
    const zeros = new BigInt64Array(seqLen); // token_type_ids: single segment
    const declared = session.inputNames;

    const feeds: Record<string, unknown> = {};
    for (const name of declared) {
      switch (name) {
        case "input_ids":
          feeds[name] = new ort.Tensor("int64", ids, [1, seqLen]);
          break;
        case "attention_mask":
          feeds[name] = new ort.Tensor("int64", mask, [1, seqLen]);
          break;
        case "token_type_ids":
          feeds[name] = new ort.Tensor("int64", zeros, [1, seqLen]);
          break;
        default:
          // Unknown declared input: skip it rather than guessing a shape.
          // If the graph truly needs it, session.run surfaces the error.
          syslog(
            "warn",
            "embeddings",
            `ONNX model declares an unsupported input "${name}"; omitting it`
          );
      }
    }

    const output = await session.run(feeds);
    const tensor = pickEmbeddingTensor(
      output,
      seqLen,
      attentionMask,
      modelPath,
      explicitPoolingMode
    );
    if (!tensor) {
      syslog(
        "warn",
        "embeddings",
        "ONNX output is token-level and no pooling mode could be resolved; memory will be stored without a vector"
      );
      return null;
    }
    return l2Normalize(tensor);
  } catch (err) {
    syslog(
      "error",
      "embeddings",
      `ONNX embedding inference failed: ${err instanceof Error ? err.message : String(err)}`
    );
    // Release the likely-broken session.
    await releaseOnnxSession(ONNX_SLOT_EMBEDDING);
    return null;
  }
}

type ResolvedEndpoint = {
  kind: "openai-compatible" | "ollama" | "onnx";
  baseUrl?: string;
  apiKey?: string;
  modelPath?: string;
  /** User-selected pooling (tier 3); absent = auto-resolve from sidecar. */
  poolingMode?: PoolingMode;
};

/** Pick the endpoint for the saved configuration. */
function resolveEndpoint(config: EmbeddingConfig): ResolvedEndpoint | null {
  if (config.provider === "ollama" && config.baseUrl) {
    return { kind: "ollama", baseUrl: config.baseUrl };
  }
  if (config.provider === "openai-compatible" && config.baseUrl) {
    return {
      kind: "openai-compatible",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    };
  }
  if (config.provider === "onnx") {
    const modelPath = resolveEmbeddingOnnxPath(config.modelPath);
    if (!modelPath) return null;
    return { kind: "onnx", modelPath, poolingMode: config.poolingMode };
  }
  // "server" — or a misconfigured explicit provider — resolves from the
  // baseUrl carried on the config (set from the registry's "server"
  // provider entry by getEmbeddingConfigFromRegistry).
  if (config.baseUrl) {
    return {
      kind: "openai-compatible",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    };
  }
  return null;
}

async function embedSingle(
  endpoint: ResolvedEndpoint,
  model: string,
  text: string
): Promise<Float32Array | null> {
  if (endpoint.kind === "onnx") {
    return requestOnnxEmbedding(endpoint.modelPath!, text, endpoint.poolingMode);
  }
  if (endpoint.kind === "ollama") {
    return requestOllamaEmbedding(endpoint.baseUrl!, model, text);
  }
  return requestOpenAICompatibleEmbedding(
    endpoint.baseUrl!,
    endpoint.apiKey,
    model,
    text
  );
}

/** Ollama native POST {base}/api/embed → embeddings[0] (L2-normalized). */
async function requestOllamaEmbedding(
  baseUrl: string,
  model: string,
  text: string
): Promise<Float32Array | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [text] }),
      signal: AbortSignal.timeout(EMBEDDING_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      syslog("warn", "embeddings", `Ollama embed request failed with status ${response.status}: ${response.statusText}`);
      return null;
    }

    // Same SSE-tail guard as the OpenAI-compatible path (see 39a2267).
    const rawBody = await response.text();
    const data = JSON.parse(stripStraySseTail(rawBody)) as {
      embeddings?: Array<unknown>;
    };
    const raw = data?.embeddings?.[0];
    if (Array.isArray(raw)) return new Float32Array(raw);
    return null;
  } catch (err) {
    syslog("warn", "embeddings", `Failed to fetch Ollama embedding: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Embed a text. Model resolution: explicit argument → saved setting →
 * EMBEDDING_MODEL_ID env → default. Text longer than the configured
 * chunk size is chunked (with overlap) and mean-pooled.
 *
 * Returns `null` when no endpoint is configured or every embedding attempt
 * failed. Callers must then store the memory WITHOUT a vector — it stays
 * full-text searchable, and the deep-sleep backfill sweep re-embeds it once
 * the endpoint recovers. Synthetic fallback vectors are deliberately not
 * used: mixing fake and real embeddings silently corrupts every cosine/KNN
 * retrieval downstream.
 */
export async function generateEmbedding(
  text: string,
  model?: string
): Promise<Float32Array | null> {
  let config: EmbeddingConfig;
  try {
    config = await getEmbeddingConfigFromRegistry();
  } catch (err) {
    syslog("warn", "embeddings", `Failed to read provider registry; memory will be stored without a vector: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const endpoint = resolveEndpoint(config);
  if (!endpoint) {
    syslog("warn", "embeddings", "No embedding endpoint configured; memory will be stored without a vector.");
    return null;
  }

  const defaultModel = getDefaultModelForProvider(config.provider);
  const modelId =
    model || config.model || env.EMBEDDING_MODEL_ID || defaultModel;

  // Check LRU cache for single-chunk text (standard search queries)
  const trimmedText = text.trim();
  const cacheKey = getCacheKey(endpoint, modelId, trimmedText);
  if (trimmedText.length <= config.chunkSize) {
    const cached = embeddingLruCache.get(cacheKey);
    if (cached) {
      // Refresh LRU order: delete and re-insert
      embeddingLruCache.delete(cacheKey);
      embeddingLruCache.set(cacheKey, cached);
      return cached;
    }
  }

  if (text.length <= config.chunkSize) {
    const result = await embedSingle(endpoint, modelId, text);
    if (result) {
      if (embeddingLruCache.size >= MAX_EMBEDDING_CACHE_ENTRIES) {
        const oldestKey = embeddingLruCache.keys().next().value;
        if (oldestKey) embeddingLruCache.delete(oldestKey);
      }
      embeddingLruCache.set(cacheKey, result);
    }
    return result;
  }

  const chunks = chunkText(text, config.chunkSize, config.chunkOverlap);
  const vectors: Float32Array[] = [];
  for (const chunk of chunks) {
    const vec = await embedSingle(endpoint, modelId, chunk);
    if (vec) vectors.push(vec);
  }
  if (vectors.length === 0) {
    return null;
  }
  return meanPool(vectors);
}

export type DimensionProbe = {
  /** Registry provider id whose endpoint should be probed. */
  providerId?: string;
  /** Standalone endpoint (used when providerId is absent). */
  provider?: EmbeddingProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** ONNX model file (used when provider === "onnx"). */
  modelPath?: string;
};

export type DimensionProbeResult = {
  dimensions: number;
  model: string;
  latencyMs: number;
};

/**
 * Auto-detect a model's native vector dimension by embedding a short
 * probe text and measuring the returned vector length. Throws when the
 * endpoint is unreachable or the model is unknown.
 */
export async function detectEmbeddingDimensions(
  probe: DimensionProbe
): Promise<DimensionProbeResult> {
  // A registry providerId resolves the endpoint server-side (with its
  // stored secret); the client never needs to send a key.
  if (probe.providerId) {
    const entry = (await loadRegistry()).providers.find(
      (p) => p.id === probe.providerId
    );
    if (!entry) {
      throw new Error(`Provider "${probe.providerId}" not found in the registry`);
    }
    const defaultModel = getDefaultModelForProvider(
      entry.kind === "ollama" ? "ollama" : "openai-compatible"
    );
    const modelId =
      probe.model || env.EMBEDDING_MODEL_ID || defaultModel;
    const endpoint: ResolvedEndpoint = {
      kind: entry.kind === "ollama" ? "ollama" : "openai-compatible",
      baseUrl: entry.baseUrl,
      apiKey: await resolveApiKey(entry),
    };
    const start = Date.now();
    const vec = await embedSingle(endpoint, modelId, PROBE_TEXT);
    if (!vec) {
      throw new Error(
        "Embedding probe failed — endpoint unreachable or model unknown"
      );
    }
    return {
      dimensions: vec.length,
      model: modelId,
      latencyMs: Date.now() - start,
    };
  }

  const defaultModel = getDefaultModelForProvider(probe.provider ?? "server");
  const modelId =
    probe.model || env.EMBEDDING_MODEL_ID || defaultModel;

  let endpoint: ResolvedEndpoint | null;
  if (probe.provider === "ollama") {
    if (!probe.baseUrl) throw new Error("Ollama provider requires a base URL");
    endpoint = { kind: "ollama", baseUrl: probe.baseUrl };
  } else if (probe.provider === "openai-compatible") {
    if (!probe.baseUrl) {
      throw new Error("OpenAI-compatible provider requires a base URL");
    }
    endpoint = {
      kind: "openai-compatible",
      baseUrl: probe.baseUrl,
      apiKey: probe.apiKey,
    };
  } else if (probe.provider === "onnx") {
    // ONNX: probe the resolved model file to read its native output dimension.
    // modelPath (explicit file) wins; `model` is accepted as an alias so the
    // shared probe payload shape works for every provider.
    const modelPath = resolveEmbeddingOnnxPath(
      probe.modelPath ?? probe.model
    );
    if (!modelPath) {
      throw new Error(
        "No valid ONNX embedding model found in data/models/embedding/"
      );
    }
    endpoint = { kind: "onnx", modelPath };
  } else {
    // "server" — the registry's own LLM entry (id "server").
    const server = (await loadRegistry()).providers.find(
      (p) => p.id === "server"
    );
    if (!server) {
      throw new Error("Server provider is not configured in the registry");
    }
    endpoint = {
      kind: "openai-compatible",
      baseUrl: server.baseUrl,
      apiKey: await resolveApiKey(server),
    };
  }

  const start = Date.now();
  const vec = await embedSingle(endpoint, modelId, PROBE_TEXT);
  if (!vec) {
    throw new Error(
      "Embedding probe failed — endpoint unreachable or model unknown"
    );
  }
  return { dimensions: vec.length, model: modelId, latencyMs: Date.now() - start };
}

/**
 * Resolves the embedding model ID that would be used by `generateEmbedding`
 * for a given optional model override. Used to tag stored embeddings so the
 * backfill pass can detect stale vectors after a model change. Returns
 * "unknown" when the registry / config cannot be read.
 */
export async function resolveEmbeddingModel(model?: string): Promise<string> {
  let config: EmbeddingConfig;
  try {
    config = await getEmbeddingConfigFromRegistry();
  } catch {
    return model ?? "unknown";
  }
  if (config.provider === "onnx") {
    return model || (config.modelPath ? `onnx:${config.modelPath}` : "onnx:default");
  }
  const defaultModel = getDefaultModelForProvider(config.provider);
  return model || config.model || env.EMBEDDING_MODEL_ID || defaultModel;
}
