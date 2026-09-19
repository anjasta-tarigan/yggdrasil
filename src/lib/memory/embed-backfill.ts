import { eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import {
  generateEmbedding,
  getEmbeddingConfigFromRegistry,
  resolveEmbeddingModel,
  vectorToBuffer,
} from "./embeddings";
import { releaseAllOnnxSessions } from "./onnx-session";
import { purgeAllVectorIndexes } from "./vector-index";
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

/**
 * Selects rows for a full rebuild: every row with content, whether or not it
 * already carries an embedding under the target model. Rows are overwritten in
 * place, so a mid-pass failure cannot strip vectors that were previously good.
 */
export const rebuildAllRows = (contentCol: AnySQLiteColumn) =>
  isNotNull(contentCol);

export type BackfillOptions = {
  /** Maximum number of rows to re-embed per pass (shared across tiers). */
  limit?: number;
  db?: AppDatabase;
  /** Override the resolved embedding model (defaults to live resolution). */
  embeddingModel?: string;
  totalRows?: number;
  onProgress?: (current: number, total: number) => void;
  /**
   * Re-embed every row regardless of its stored model tag. Used by the full
   * rebuild pass, where the intent is to replace all vectors (not just the
   * ones already flagged as stale). Rows are overwritten in place, so an
   * endpoint failure mid-pass leaves untouched rows holding their previous
   * vectors rather than leaving the table vector-less.
   */
  forceAll?: boolean;
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

  let totalRows = options.totalRows;
  if (typeof totalRows !== "number") {
    const [ep] = await db
      .select({ count: sql<number>`count(*)` })
      .from(episodicMemories)
      .where(needsReembed(episodicMemories.embedding, episodicMemories.embeddingModel, embeddingModel));
    const [sem] = await db
      .select({ count: sql<number>`count(*)` })
      .from(semanticMemories)
      .where(needsReembed(semanticMemories.embedding, semanticMemories.embeddingModel, embeddingModel));
    totalRows = Number(ep?.count ?? 0) + Number(sem?.count ?? 0);
  }
  options.onProgress?.(0, totalRows);

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
          .where(
            options.forceAll
              ? rebuildAllRows(episodicMemories.content)
              : needsReembed(episodicMemories.embedding, episodicMemories.embeddingModel, embeddingModel)
          )
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
          .where(
            options.forceAll
              ? rebuildAllRows(semanticMemories.content)
              : needsReembed(semanticMemories.embedding, semanticMemories.embeddingModel, embeddingModel)
          )
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
      options.onProgress?.(embeddedCount, totalRows);
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
  /**
   * Rows the rebuild pass visited (i.e. every row with content). Retained
   * under this name for wire compatibility with existing clients; on a full
   * rebuild each visited row has its vector replaced.
   */
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
 * rows) by re-embedding every row under the current model. Each row is
 * overwritten in place: the new vector replaces the old one atomically, so if
 * the embedding endpoint goes down mid-pass the rows not yet visited keep
 * their previous vectors. An earlier implementation nulled the whole table
 * first, which turned a mid-pass outage into total, unrecoverable vector loss.
 *
 * The vec index is rebuilt lazily on the next search via `syncVectorIndex`,
 * which re-populates from the base tables by dimension.
 *
 * Use case: the user changed the embedding model and confirmed the rebuild.
 */
export async function rebuildEmbeddingIndex(
  options: {
    db?: AppDatabase;
    onProgress?: (current: number, total: number) => void;
  } = {}
): Promise<RebuildIndexResult> {
  const db = options.db ?? defaultDb;
  const embeddingModel = await resolveEmbeddingModel();

  // If the target provider is not ONNX, ensure any loaded ONNX session is released
  try {
    const config = await getEmbeddingConfigFromRegistry();
    if (config.provider !== "onnx") {
      await releaseAllOnnxSessions();
    }
  } catch (err) {
    syslog("debug", "embed-backfill", `Error: ${err instanceof Error ? err.message : String(err)}`);
    // Non-fatal if config fails to load
  }

  // Purge every vector index — including sqlite-vec's shadow tables — before
  // re-embedding. A model switch invalidates every stored vector: the old
  // index is dimensionally incompatible and its shadow tables would otherwise
  // keep the stale blobs in the database file indefinitely. The indexes are
  // rebuilt from the base tables by the next `syncVectorIndex` call.
  const resolvedSqlite =
    (db as unknown as { $client?: Database.Database }).$client ?? defaultSqlite;
  let purgedIndexes = 0;
  try {
    purgedIndexes = purgeAllVectorIndexes(resolvedSqlite);
    if (purgedIndexes > 0) {
      syslog(
        "info",
        "embed-backfill",
        `rebuildEmbeddingIndex: purged ${purgedIndexes} vector index table(s)`
      );
    }
  } catch (err) {
    syslog(
      "warn",
      "embed-backfill",
      `rebuildEmbeddingIndex: vector index purge failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Count the rows this pass will visit (every row with content) so progress
  // reporting has a total. No rows are mutated here — see the forceAll path in
  // runEmbeddingBackfill, which overwrites each vector in place.
  const [epCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(episodicMemories)
    .where(isNotNull(episodicMemories.content));
  const [semCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(semanticMemories)
    .where(isNotNull(semanticMemories.content));
  const totalCount = Number(epCount?.count ?? 0) + Number(semCount?.count ?? 0);

  syslog(
    "info",
    "embed-backfill",
    `rebuildEmbeddingIndex: re-embedding ${totalCount} rows under model "${embeddingModel}"`
  );

  options.onProgress?.(0, totalCount);

  if (totalCount === 0) {
    options.onProgress?.(0, 0);
    return { nulledCount: 0, embeddedCount: 0, remaining: 0 };
  }

  // Re-embed every row in place. `forceAll` selects all rows rather than only
  // those already flagged stale, so a model switch replaces every vector.
  const { embeddedCount, remaining } = await runEmbeddingBackfill({
    db,
    embeddingModel,
    limit: REBUILD_ALL_LIMIT,
    totalRows: totalCount,
    onProgress: options.onProgress,
    forceAll: true,
  });

  return { nulledCount: totalCount, embeddedCount, remaining };
}
