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

export async function generateEmbedding(
  text: string,
  model?: string
): Promise<Float32Array> {
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL) {
    return createDeterministicEmbedding(text);
  }

  const modelId = model || process.env.EMBEDDING_MODEL_ID || "text-embedding-3-small";

  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        input: text,
        model: modelId,
      }),
    });

    if (!response.ok) {
      console.warn(
        `[embeddings] Remote embedding request failed with status ${response.status}: ${response.statusText}, using deterministic fallback.`
      );
      return createDeterministicEmbedding(text);
    }

    const data = await response.json();
    const raw = data?.data?.[0]?.embedding;
    if (Array.isArray(raw)) {
      return new Float32Array(raw);
    }
  } catch (err) {
    console.warn(
      "[embeddings] Failed to fetch remote embedding, using deterministic fallback:",
      err
    );
  }

  return createDeterministicEmbedding(text);
}
