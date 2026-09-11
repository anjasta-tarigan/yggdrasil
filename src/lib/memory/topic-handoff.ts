import type Database from "better-sqlite3";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
  resolveEmbeddingModel,
} from "./embeddings";
import { addSemanticMemory } from "./semantic-memory";
import { syslog } from "@/lib/observability/log-store";

/**
 * Cosine-similarity threshold below which a new user message is considered
 * to be on a *different* topic from the conversation it is being appended to.
 * 0.35 is low enough that loosely-related follow-ups stay within the same
 * topic, but a hard pivot (e.g. "now debug this" after a feature discussion)
 * will be caught.
 */
export const TOPIC_SHIFT_THRESHOLD = 0.35;

/**
 * Number of recent user-visible episodic memories to sample when measuring
 * topical continuity. We sample the most recent handful rather than the full
 * conversation to keep the cost O(k) and avoid diluting the signal with
 * old, unrelated turns.
 */
export const TOPIC_SAMPLE_SIZE = 5;

export type TopicHandoffResult = {
  /** True if a topic boundary was detected and a marker was created. */
  shifted: boolean;
  /** Cosine similarity between the new message and the recent centroid. */
  similarity: number;
  /** IDs of the boundary marker memory, if created. */
  boundaryId: string | null;
};

/**
 * Inspects the last `TOPIC_SAMPLE_SIZE` episodic memories for a session,
 * computes their embedding centroid, and compares it (cosine similarity)
 * to a freshly embedded version of `newUserMessage`. If the similarity
 * drops below `TOPIC_SHIFT_THRESHOLD`, a semantic "topic boundary" memory
 * is written — tagged `topic_handoff` — so downstream compaction and
 * reflection know to start a fresh summary rather than carrying the old
 * topic's context forward.
 *
 * All failures are non-fatal: a broken embedding pipeline or DB hiccup
 * simply returns `shifted: false` so the chat path is never blocked.
 */
export async function detectAndMarkTopicShift(
  sessionId: string | undefined,
  newUserMessage: string,
  options: {
    db?: AppDatabase;
    sqlite?: Database.Database;
    threshold?: number;
    sampleSize?: number;
  } = {}
): Promise<TopicHandoffResult> {
  const db = options.db ?? defaultDb;
  const sqlite = options.sqlite ?? defaultSqlite;
  const threshold = options.threshold ?? TOPIC_SHIFT_THRESHOLD;
  const sampleSize = options.sampleSize ?? TOPIC_SAMPLE_SIZE;

  if (!newUserMessage || newUserMessage.trim().length === 0) {
    return { shifted: false, similarity: 1, boundaryId: null };
  }

  // 1. Fetch the most recent episodic memories for this session that
  //    already have an embedding vector.
  const recentRows = db
    .select({
      id: episodicMemories.id,
      content: episodicMemories.content,
      embedding: episodicMemories.embedding,
    })
    .from(episodicMemories)
    .where(
      and(
        eq(episodicMemories.sessionId, sessionId ?? ""),
        isNull(episodicMemories.consolidatedInto),
        isNotNull(episodicMemories.embedding)
      )
    )
    .orderBy(desc(episodicMemories.createdAt))
    .limit(sampleSize)
    .all();

  if (recentRows.length === 0) {
    // No prior context — no boundary needed, this is the first topic.
    return { shifted: false, similarity: 1, boundaryId: null };
  }

  // 2. Compute the centroid of the recent embeddings.
  const vectors = recentRows
    .map((r) => bufferToVector(r.embedding as Buffer))
    .filter((v) => v.length > 0);

  if (vectors.length === 0) {
    return { shifted: false, similarity: 1, boundaryId: null };
  }

  const dim = vectors[0].length;
  const centroid = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) continue; // skip dimension mismatches
    for (let i = 0; i < dim; i++) {
      centroid[i] += v[i];
    }
  }
  // L2-normalize the centroid so cosine similarity is meaningful.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += centroid[i] * centroid[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) centroid[i] /= norm;
  }

  // 3. Embed the new message and compare.
  let newVector: Float32Array | null;
  try {
    newVector = await generateEmbedding(newUserMessage);
  } catch {
    return { shifted: false, similarity: 1, boundaryId: null };
  }

  if (!newVector || newVector.length !== dim) {
    return { shifted: false, similarity: 1, boundaryId: null };
  }

  const similarity = cosineSimilarity(newVector, centroid);

  if (similarity < threshold) {
    // 4. Topic shift detected — write a boundary marker.
    const embeddingModel = await resolveEmbeddingModel();
    const oldCentroidContent = recentRows
      .map((r) => r.content)
      .join("\n---\n")
      .slice(0, 500);

    const boundaryContent = `[TOPIC HANDOFF BOUNDARY]\nPrevious topic summary: ${oldCentroidContent}\nUser message at boundary: ${newUserMessage.slice(0, 200)}`;

    let boundaryId: string | null = null;
    try {
      boundaryId = await addSemanticMemory(
        {
          content: boundaryContent,
          embedding: newVector,
          embeddingModel,
          importance: 0.7,
          tags: ["topic_handoff", "boundary_marker"],
          metadata: {
            similarity,
            threshold,
            oldCentroidContent,
          },
        },
        db
      );
    } catch (err) {
      syslog("warn", "memory", `Failed to write topic handoff boundary: ${err}`);
    }

    syslog(
      "info",
      "memory",
      `Topic shift detected (cosine=${similarity.toFixed(3)} < ${threshold}) for session ${sessionId ?? "unknown"}; boundary ${boundaryId ?? "failed"}`
    );

    return { shifted: true, similarity, boundaryId };
  }

  return { shifted: false, similarity, boundaryId: null };
}
