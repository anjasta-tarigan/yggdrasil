import { getSettingDb } from "@/lib/settings-service";

/**
 * Embedding engine for the memory system.
 *
 * Provider routing (Settings → Embedding, stored in SQLite):
 *  - "server"            — the app's own LLM endpoint (LLM_BASE_URL env)
 *  - "openai-compatible" — any cloud/self-hosted /embeddings endpoint
 *  - "ollama"            — local Ollama via its native /api/embed endpoint
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

const DEFAULT_MODEL_ID = "text-embedding-3-small";

/** Short neutral text used for dimension probes. */
const PROBE_TEXT = "Yggdrasil embedding dimension probe";

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

/**
 * Deterministic hash-based 64-dim float vector for offline / testing fallbacks.
 */
function createDeterministicEmbedding(text: string, dim = 64): Float32Array {
  const vector = new Float32Array(dim);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  for (let i = 0; i < dim; i++) {
    const val = Math.sin(hash + i);
    vector[i] = val;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vector[i] /= norm;
  }
  return vector;
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
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  let stored: Record<string, unknown> = {};
  try {
    const raw = getSettingDb("embedding");
    if (typeof raw === "object" && raw !== null) {
      stored = raw as Record<string, unknown>;
    }
  } catch {
    // Database unavailable — use defaults.
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
        current = current.slice(
          -(Math.max(0, chunkSize - sentence.length))
        );
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
    });

    if (!response.ok) {
      console.warn(
        `[embeddings] Remote embedding request failed with status ${response.status}: ${response.statusText}`
      );
      return null;
    }

    const data = await response.json();
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
    });

    if (!response.ok) {
      console.warn(
        `[embeddings] Ollama embed request failed with status ${response.status}: ${response.statusText}`
      );
      return null;
    }

    const data = await response.json();
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

/** Pick the endpoint for the saved configuration (or env fallback). */
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
  // "server" provider — or a misconfigured explicit provider — falls back
  // to the app's own LLM endpoint from the environment.
  if (process.env.LLM_BASE_URL) {
    return {
      kind: "openai-compatible",
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
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
 */
export async function generateEmbedding(
  text: string,
  model?: string
): Promise<Float32Array> {
  const config = getEmbeddingConfig();
  const endpoint = resolveEndpoint(config);
  if (!endpoint) {
    return createDeterministicEmbedding(text);
  }

  const modelId =
    model || config.model || process.env.EMBEDDING_MODEL_ID || DEFAULT_MODEL_ID;

  if (text.length <= config.chunkSize) {
    const vec = await embedSingle(endpoint, modelId, text);
    return vec ?? createDeterministicEmbedding(text);
  }

  const chunks = chunkText(text, config.chunkSize, config.chunkOverlap);
  const vectors: Float32Array[] = [];
  for (const chunk of chunks) {
    const vec = await embedSingle(endpoint, modelId, chunk);
    if (vec) vectors.push(vec);
  }
  if (vectors.length === 0) {
    return createDeterministicEmbedding(text);
  }
  return meanPool(vectors);
}

export type DimensionProbe = {
  provider: EmbeddingProviderKind;
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
  const modelId =
    probe.model || process.env.EMBEDDING_MODEL_ID || DEFAULT_MODEL_ID;

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
    if (!process.env.LLM_BASE_URL) {
      throw new Error("Server provider has no LLM_BASE_URL configured");
    }
    endpoint = {
      kind: "openai-compatible",
      baseUrl: process.env.LLM_BASE_URL,
      apiKey: process.env.LLM_API_KEY,
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
