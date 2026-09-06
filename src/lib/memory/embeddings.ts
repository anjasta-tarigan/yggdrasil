import { getSettingDb } from "@/lib/settings-service";
import { stripStraySseTail } from "@/lib/ai/provider";
import { loadRegistry, resolveApiKey } from "@/lib/ai/provider-config/store";

/**
 * Embedding engine for the memory system.
 *
 * Provider routing (provider registry — see lib/ai/provider-config):
 *  - "server"            — the registry's "server" provider entry
 *  - "openai-compatible" — any cloud/self-hosted /embeddings endpoint
 *  - "ollama"            — local Ollama via its native /api/embed endpoint
 *
 * The legacy SQLite-backed getEmbeddingConfig() remains exported for the
 * settings route until Task 5 migrates it.
 *
 * Long text is split into overlapping chunks (industry default ≈512
 * tokens with 10–20% overlap), each chunk is embedded, and the chunks
 * are mean-pooled into one L2-normalized vector per memory. When no
 * endpoint is reachable, a deterministic 64-dim hash vector keeps the
 * pipeline functional offline.
 */

export type EmbeddingProviderKind = "server" | "openai-compatible" | "ollama";

export type EmbeddingConfig = {
  provider: EmbeddingProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Auto-detected native vector length of the configured model. */
  dimensions?: number;
  /** Chunk size in characters (≈4 chars per token). */
  chunkSize: number;
  /** Overlap between consecutive chunks in characters. */
  chunkOverlap: number;
};

/** ≈512 tokens at ~4 chars/token — the common retrieval sweet spot. */
export const DEFAULT_CHUNK_SIZE = 2000;
/** 10% of the default chunk size (recommended range: 10–20%). */
export const DEFAULT_CHUNK_OVERLAP = 200;

export const MIN_CHUNK_SIZE = 200;
export const MAX_CHUNK_SIZE = 20000;

export const DEFAULT_OPENAI_MODEL_ID = "text-embedding-3-small";
export const DEFAULT_OLLAMA_MODEL_ID = "nomic-embed-text";
export const EMBEDDING_FETCH_TIMEOUT_MS = 5000;

/** Pick the standard fallback model for a provider when none is configured. */
export function getDefaultModelForProvider(
  provider: EmbeddingProviderKind
): string {
  return provider === "ollama"
    ? DEFAULT_OLLAMA_MODEL_ID
    : DEFAULT_OPENAI_MODEL_ID;
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
  return `${endpoint.kind}:${endpoint.baseUrl}:${model}:${text}`;
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
    console.warn("[embeddings] Failed to read embedding settings:", err);
  }

  const provider: EmbeddingProviderKind =
    stored.provider === "ollama" || stored.provider === "openai-compatible"
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
 *  1. embedding.providerId set → that provider entry supplies baseUrl +
 *     apiKey (kind "ollama" → provider "ollama", else "openai-compatible").
 *  2. providerId null → standalone block: inline baseUrl + apiKeyEnv
 *     (an http(s) baseUrl means "openai-compatible", otherwise "server").
 *  3. No embedding block → "server" provider entry, else bare "server"
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
 * from being fragmented (recommended 10–20% of chunk size).
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
      console.warn(
        `[embeddings] Remote embedding request failed with status ${response.status}: ${response.statusText}`
      );
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
    console.warn("[embeddings] Failed to fetch remote embedding:", err);
    return null;
  }
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
      console.warn(
        `[embeddings] Ollama embed request failed with status ${response.status}: ${response.statusText}`
      );
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
    console.warn("[embeddings] Failed to fetch Ollama embedding:", err);
    return null;
  }
}

type ResolvedEndpoint = {
  kind: "openai-compatible" | "ollama";
  baseUrl: string;
  apiKey?: string;
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
  return endpoint.kind === "ollama"
    ? requestOllamaEmbedding(endpoint.baseUrl, model, text)
    : requestOpenAICompatibleEmbedding(
        endpoint.baseUrl,
        endpoint.apiKey,
        model,
        text
      );
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
    console.warn(
      "[embeddings] Failed to read provider registry; memory will be stored without a vector.",
      err
    );
    return null;
  }
  const endpoint = resolveEndpoint(config);
  if (!endpoint) {
    console.warn(
      "[embeddings] No embedding endpoint configured; memory will be stored without a vector."
    );
    return null;
  }

  const defaultModel = getDefaultModelForProvider(config.provider);
  const modelId =
    model || config.model || process.env.EMBEDDING_MODEL_ID || defaultModel;

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
      probe.model || process.env.EMBEDDING_MODEL_ID || defaultModel;
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
    probe.model || process.env.EMBEDDING_MODEL_ID || defaultModel;

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
