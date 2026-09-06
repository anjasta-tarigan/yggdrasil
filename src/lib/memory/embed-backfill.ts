import { eq, isNull, lt, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import { generateEmbedding, vectorToBuffer } from "./embeddings";

export type BackfillOptions = {
  /** Maximum number of rows to re-embed per pass (shared across tiers). */
  limit?: number;
  db?: AppDatabase;
};

export interface BackfillResult {
  embeddedCount: number;
  remaining: number;
}

/**
 * Re-embeds memories that were stored without a vector because the
 * embedding endpoint was down or unconfigured at write time (see
 * `generateEmbedding` returning null). Runs inside the daily deep-sleep
 * job, bounded per pass so a large backlog spreads across sweeps instead
 * of stalling the queue. When the endpoint is still unreachable the pass
 * stops at the first failure and resumes on the next sweep.
 */
export async function runEmbeddingBackfill(
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const limit = options.limit ?? 50;
  const db = options.db ?? defaultDb;
  let budget = limit;
  let embeddedCount = 0;
  let endpointDown = false;

  // Rows eligible for (re-)embedding: never-embedded rows (embedding IS
  // NULL) PLUS legacy zero-length rows (length(embedding) = 0). The previous
  // pass wrote Buffer.alloc(0) on per-row failures, which is NOT NULL in
  // SQLite — permanently hiding those memories from backfill selection,
  // vec-index sync, and the "unembedded" counts. Zero-length is treated as
  // "needs retry" everywhere now.
  const needsEmbedding = (col: AnySQLiteColumn) =>
    or(isNull(col), sql`length(${col}) = 0`);

  const tiers = [
    {
      table: episodicMemories,
      rows: async () =>
        db
          .select({
            id: episodicMemories.id,
            content: episodicMemories.content,
          })
          .from(episodicMemories)
          .where(needsEmbedding(episodicMemories.embedding))
          .limit(budget),
      update: (id: string, buffer: Buffer) =>
        db
          .update(episodicMemories)
          .set({ embedding: buffer })
          .where(eq(episodicMemories.id, id))
          .run(),
    },
    {
      table: semanticMemories,
      rows: async () =>
        db
          .select({
            id: semanticMemories.id,
            content: semanticMemories.content,
          })
          .from(semanticMemories)
          .where(needsEmbedding(semanticMemories.embedding))
          .limit(budget),
      update: (id: string, buffer: Buffer) =>
        db
          .update(semanticMemories)
          .set({ embedding: buffer })
          .where(eq(semanticMemories.id, id))
          .run(),
    },
  ];

  for (const tier of tiers) {
    if (budget <= 0 || endpointDown) break;
    const rows = await tier.rows();
    for (const row of rows) {
      if (budget <= 0) break;
      const vector = await generateEmbedding(row.content);
      if (!vector) {
        // Probe if the endpoint is truly down or if this row failed specifically.
        const probe = await generateEmbedding("probe");
        if (!probe) {
          endpointDown = true;
          break;
        }
        // Endpoint is alive, but this specific row cannot be embedded.
        // Skip WITHOUT writing anything: leave the row NULL so later
        // sweeps (or a fixed endpoint) can retry it — a zero-length blob
        // would permanently remove it from selection, vec sync, and counts.
        console.warn(`[embed-backfill] Skipping un-embeddable memory row ${row.id}`);
        budget--;
        continue;
      }
      tier.update(row.id, vectorToBuffer(vector));
      embeddedCount++;
      budget--;
    }
  }

  const [episodicRemaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(episodicMemories)
    .where(needsEmbedding(episodicMemories.embedding));
  const [semanticRemaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(semanticMemories)
    .where(needsEmbedding(semanticMemories.embedding));

  return {
    embeddedCount,
    remaining: Number(episodicRemaining?.count ?? 0) + Number(semanticRemaining?.count ?? 0),
  };
}
