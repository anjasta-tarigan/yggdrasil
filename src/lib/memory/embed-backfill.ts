import { eq, isNull, ne, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import {
  generateEmbedding,
  resolveEmbeddingModel,
  vectorToBuffer,
} from "./embeddings";
import { syslog } from "@/lib/observability/log-store";

/**
 * Builds a WHERE clause matching columns whose embedding needs (re-)generation:
 * NULL values (never embedded) plus zero-length blobs left by prior failures.
 */
export const needsEmbedding = (col: AnySQLiteColumn) =>
  or(isNull(col), sql`length(${col}) = 0`);

/**
 * Builds a WHERE clause matching rows needing re-embedding: never-embedded
 * rows, legacy zero-length rows, rows whose stored embedding_model doesn't
 * match `embeddingModel`, and rows with no model tag (un-versioned).
 *
 * `ne(..., model)` returns NULL (falsy) when modelCol is NULL, so `isNull(modelCol)`
 * is included to catch legacy memories that have a vector but no model tag.
 */
export const needsReembed = (
  col: AnySQLiteColumn,
  modelCol: AnySQLiteColumn,
  embeddingModel: string,
) =>
  or(needsEmbedding(col), ne(modelCol, embeddingModel), isNull(modelCol));

export type BackfillOptions = {
  /** Maximum number of rows to re-embed per pass (shared across tiers). */
  limit?: number;
  db?: AppDatabase;
  /** Override the resolved embedding model (defaults to live resolution). */
  embeddingModel?: string;
};

export interface BackfillResult {
  embeddedCount: number;
  remaining: number;
}

/** Batch size used by the full rebuild pass — processes everything in one go. */
const REBUILD_ALL_LIMIT = 1_000_000;

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
  const embeddingModel =
    options.embeddingModel ?? (await resolveEmbeddingModel());
  let budget = limit;
  let embeddedCount = 0;
  let endpointDown = false;

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
          .where(needsReembed(episodicMemories.embedding, episodicMemories.embeddingModel, embeddingModel))
          .limit(budget),
      update: (id: string, buffer: Buffer) =>
        db
          .update(episodicMemories)
          .set({ embedding: buffer, embeddingModel })
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
          .where(needsReembed(semanticMemories.embedding, semanticMemories.embeddingModel, embeddingModel))
          .limit(budget),
      update: (id: string, buffer: Buffer) =>
        db
          .update(semanticMemories)
          .set({ embedding: buffer, embeddingModel })
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
        syslog("warn", "embed-backfill", `Skipping un-embeddable memory row ${row.id}`);
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

export interface RebuildIndexResult {
  /** Total rows nulled across both tiers before re-embedding. */
  nulledCount: number;
  /** Rows that received a fresh embedding during this pass. */
  embeddedCount: number;
  /** Rows still without an embedding after this pass (endpoint failures). */
  remaining: number;
}

/**
 * Force a full re-embed of ALL episodic and semantic memory rows.
 *
 * This differs from `runEmbeddingBackfill` (which only targets NULL/stale
 * rows) by nulling every existing embedding in a single transaction,
 * then delegating to the backfill pass with no model filter. The vec
 * index is rebuilt lazily on the next search via `syncVectorIndex`.
 *
 * Use case: the user changed the embedding model. Old vectors are
 * dimension- and model-incompatible; nulling them guarantees the backfill
 * pass re-embeds every row under the new model.
 */
export async function rebuildEmbeddingIndex(
  options: { db?: AppDatabase } = {}
): Promise<RebuildIndexResult> {
  const db = options.db ?? defaultDb;
  const embeddingModel = await resolveEmbeddingModel();

  // Null ALL embeddings across both tables in one transaction.
  const nulledCount = db.transaction((tx) => {
    const epRows = tx
      .update(episodicMemories)
      .set({ embedding: null, embeddingModel: null })
      .run();
    const semRows = tx
      .update(semanticMemories)
      .set({ embedding: null, embeddingModel: null })
      .run();
    return (epRows.changes ?? 0) + (semRows.changes ?? 0);
  });

  syslog(
    "info",
    "embed-backfill",
    `rebuildEmbeddingIndex: nulled ${nulledCount} embeddings (episodic + semantic) under model "${embeddingModel}"`
  );

  // Delegate to backfill — now every row matches the needsReembed predicate
  // (embeddingModel is NULL, which isNull catches). Use an extremely large
  // limit so a single pass processes everything rather than the default 50.
  const { embeddedCount, remaining } = await runEmbeddingBackfill({
    db,
    embeddingModel,
    limit: REBUILD_ALL_LIMIT,
  });

  return { nulledCount, embeddedCount, remaining };
}
