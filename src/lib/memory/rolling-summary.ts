import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db as defaultDb, type AppDatabase } from "@/db";
import { semanticMemories } from "@/db/schema";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
  resolveEmbeddingModel,
} from "./embeddings";
import { syslog } from "@/lib/observability/log-store";

/** Maximum characters for a rolling summary entry (≈ 1500 tokens at 4 chars/token). */
const MAX_ROLLING_SUMMARY_CHARS = 6000;

/** Cosine-similarity threshold for matching an existing rolling summary. */
const ROLLING_SUMMARY_SIMILARITY = 0.9;

/**
 * A persistent per-chat conversation summary that is updated every turn,
 * independently of compaction. Unlike the extractive summary that
 * `compactAndPruneMessages` injects only when messages are dropped, this
 * rolling summary lives on as a semantic memory tagged `rolling_summary`
 * and is surfaced as context on every request.
 *
 * This implements the "true rolling summary" improvement: the model always
 * gets a coherent recap of what the conversation is about, even for chats
 * that never grow large enough to trigger compaction.
 */
export type RollingSummary = {
  id: string;
  content: string;
  importance: number;
};

/**
 * Retrieves the current rolling summary for a chat session, if one exists.
 * Returns the most recently updated `rolling_summary` semantic memory
 * tagged for this chat, or `null` if none has been created yet.
 */
export async function getRollingSummary(
  chatId: string,
  db: AppDatabase = defaultDb
): Promise<RollingSummary | null> {
  try {
    // NOTE: the LIKE pattern must be passed as a single bound parameter.
    // Interpolating ${chatId} inside a SQL string literal (LIKE '%"${chatId}"%'")
    // renders the ? placeholder INSIDE the literal — SQLite then treats it as a
    // literal "?" character, the bind fails with "Too many parameter values",
    // and the catch below silently degraded every lookup to null.
    const sourcesPattern = `%"${chatId}"%`;
    const rows = db
      .select({
        id: semanticMemories.id,
        content: semanticMemories.content,
        importance: semanticMemories.importance,
        embedding: semanticMemories.embedding,
        accessCount: semanticMemories.accessCount,
        lastAccessedAt: semanticMemories.lastAccessedAt,
      })
      .from(semanticMemories)
      .where(
        and(
          sql`${semanticMemories.tags} LIKE '%"rolling_summary"%'`,
          sql`${semanticMemories.sources} LIKE ${sourcesPattern}`
        )
      )
      .orderBy(sql`CAST(${semanticMemories.accessCount} AS INTEGER) DESC, ${semanticMemories.updatedAt}`)
      .limit(1)
      .all();

    // Validate that the matched row actually has the rolling_summary tag.
    for (const row of rows) {
      if (row.embedding) {
        return { id: row.id, content: row.content, importance: row.importance };
      }
    }

    // Fallback: search without embedding filter for recently updated rows.
    const taggedRows = db
      .select({
        id: semanticMemories.id,
        content: semanticMemories.content,
        importance: semanticMemories.importance,
      })
      .from(semanticMemories)
      .where(
        and(
          sql`${semanticMemories.tags} LIKE '%"rolling_summary"%'`,
          sql`${semanticMemories.sources} LIKE ${sourcesPattern}`
        )
      )
      .orderBy(sql`${semanticMemories.updatedAt}`)
      .limit(1)
      .all();

    return taggedRows.length > 0
      ? { id: taggedRows[0].id, content: taggedRows[0].content, importance: taggedRows[0].importance }
      : null;
  } catch (err) {
    syslog("warn", "memory", `Failed to retrieve rolling summary for chat ${chatId}: ${err}`);
    return null;
  }
}

/**
 * Updates the rolling summary for a chat session by incorporating a new
 * turn's content. If no summary exists yet, one is created. If one exists,
 * its content is refreshed with a combined summary of old + new content,
 * truncated to `MAX_ROLLING_SUMMARY_CHARS`.
 *
 * The summary is stored as a semantic memory tagged `rolling_summary` with
 * the chat ID as a source, so it participates in decay, access-counting,
 * and retrieval like any other memory.
 */
export async function updateRollingSummary(
  chatId: string,
  newUserMessage: string,
  assistantResponse: string,
  db: AppDatabase = defaultDb
): Promise<string | null> {
  if ((!newUserMessage && !assistantResponse) || !chatId) {
    return null;
  }

  const newContent = `User: ${newUserMessage.slice(0, 500)}\nAssistant: ${(assistantResponse ?? "").slice(0, 500)}`;

  // Check for existing rolling summary.
  const existing = await getRollingSummary(chatId, db);

  let combined: string;
  if (existing) {
    // Refresh: combine old + new, truncate to budget.
    combined = `${existing.content}\n${newContent}`;
  } else {
    combined = newContent;
  }

  if (combined.length > MAX_ROLLING_SUMMARY_CHARS) {
    combined = combined.slice(combined.length - MAX_ROLLING_SUMMARY_CHARS);
    // Align to a line boundary if possible.
    const nl = combined.indexOf("\n");
    if (nl > 0 && nl < 200) {
      combined = combined.slice(nl);
    }
  }

  // Store / update the rolling summary as a semantic memory.
  const embedding = await generateEmbedding(combined);
  const embeddingModel = await resolveEmbeddingModel();

  if (existing) {
    try {
      await db
        .update(semanticMemories)
        .set({
          content: combined,
          embedding: embedding ? bufferToBuffer(embedding) : undefined,
          embeddingModel,
          importance: Math.min(1.0, existing.importance + 0.05),
          accessCount: sql`${semanticMemories.accessCount} + 1`,
          lastAccessedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(semanticMemories.id, existing.id))
        .run();
      return existing.id;
    } catch (err) {
      syslog("warn", "memory", `Failed to update rolling summary for chat ${chatId}: ${err}`);
      return null;
    }
  }

  // New rolling summary.
  //
  // Insert directly instead of going through addSemanticMemory: that helper
  // merges near-duplicates by embedding similarity (≥0.95), which is right
  // for durable facts but wrong for per-chat state — two similar
  // conversations would have their rolling summaries silently fused into
  // one row, cross-linking their sources and serving each chat the other's
  // recap. A rolling summary is keyed by its chat, not by semantic
  // proximity.
  try {
    const id = `sem_${nanoid(12)}`;
    db.insert(semanticMemories)
      .values({
        id,
        content: combined,
        embedding: embedding ? bufferToBuffer(embedding) : null,
        embeddingModel,
        importance: 0.6,
        tags: ["rolling_summary"],
        sources: [chatId],
        metadata: { extractedFrom: "rolling_summary", chatId },
      })
      .run();
    syslog("debug", "memory", `Created rolling summary ${id} for chat ${chatId}`);
    return id;
  } catch (err) {
    syslog("warn", "memory", `Failed to create rolling summary for chat ${chatId}: ${err}`);
    return null;
  }
}

/** Convert Float32Array to a Buffer suitable for blob storage. */
function bufferToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
