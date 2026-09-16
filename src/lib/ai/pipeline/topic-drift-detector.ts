/**
 * Topic Drift ("kabur") Detection Module.
 *
 * Splits text into sentences, embeds each sentence via the shared embedding
 * infrastructure, and measures cosine similarity between consecutive
 * sentences. A drop below `threshold` (default 0.35) signals a topic shift —
 * a blind spot of pattern-fixated models that the quality scanner misses when
 * no buzzwords are present (Antislop Paper, arXiv:2510.15061).
 *
 * Design: pure heuristic splitter (no extra deps), reuses the existing
 * `generateEmbedding` / `cosineSimilarity` from the memory subsystem.
 */

import { generateEmbedding, cosineSimilarity } from "@/lib/memory/embeddings";

/** Default cosine-similarity floor below which consecutive sentences are "drifted". */
const DEFAULT_THRESHOLD = 0.35;

export interface TopicDriftReport {
  /** True when at least one consecutive sentence pair falls below the threshold. */
  driftDetected: boolean;
  /** Strength of the detected signal in [0, 1] (higher = more decisive). */
  confidence: number;
  /** The sentences the input was split into. */
  sentences: string[];
  /** Similarity floor that triggered (or would trigger) drift. */
  threshold: number;
  /** Smallest cosine similarity among consecutive pairs (null when unmeasurable). */
  minSimilarity: number | null;
}

/**
 * Split text into sentences using a heuristic boundary detector: a sentence
 * terminator (`.`, `!`, `?`) that is followed by whitespace and an uppercase
 * letter marks a boundary. This avoids the abbreviation false-positive splits
 * (e.g. "U.S.A. is great") a naïve period-split would create.
 */
function splitSentences(text: string): string[] {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return [];
  return trimmed
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split `text` into sentences, embed each one, and flag topic drift when the
 * cosine similarity between any consecutive pair drops below `threshold`.
 *
 * Returns `null` (graceful degradation) when:
 *  - the text has fewer than 3 sentences (no signal to establish), or
 *  - any sentence cannot be embedded (subsystem unavailable).
 *
 * `confidence` is the normalized distance from the threshold toward the
 * relevant extreme: 1.0 = decisive (fully orthogonal when drifted, identical
 * when coherent), tending to 0.0 near the boundary.
 */
export async function detectTopicDrift(
  text: string,
  options?: { threshold?: number; signal?: AbortSignal }
): Promise<TopicDriftReport | null> {
  if (options?.signal?.aborted) return null;
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const sentences = splitSentences(text);
  // Too few sentences to establish a drift signal; the quality scanner already
  // handles sub-threshold turns.
  if (sentences.length < 3) return null;

  // signal.aborted is checked after each await to honour cancellation.
  // generateEmbedding itself does not accept a signal, so we guard at our layer.
  const embeddings = await Promise.all(
    sentences.map((s) => generateEmbedding(s).catch(() => null))
  );
  if (options?.signal?.aborted) return null;
  // If any sentence could not be embedded we can't make a reliable comparison.
  if (embeddings.some((v) => v === null)) return null;
  const vectors = embeddings as Float32Array[];

  let minSimilarity: number | null = null;
  for (let i = 1; i < vectors.length; i++) {
    const sim = cosineSimilarity(vectors[i - 1], vectors[i]);
    if (minSimilarity === null || sim < minSimilarity) {
      minSimilarity = sim;
    }
  }
  if (minSimilarity === null) return null;

  const driftDetected = minSimilarity < threshold;
  const confidence = driftDetected
    ? Math.max(0, Math.min(1, (threshold - minSimilarity) / threshold))
    : Math.max(0, Math.min(1, (minSimilarity - threshold) / (1 - threshold)));

  return {
    driftDetected,
    confidence,
    sentences,
    threshold,
    minSimilarity,
  };
}
