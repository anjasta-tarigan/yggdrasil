import type Database from "better-sqlite3";

/**
 * sqlite-vec backed vector index for the memory tables.
 *
 * The base tables (`episodic_memories`, `semantic_memories`) keep the
 * embedding BLOBs as the source of truth; this module maintains a `vec0`
 * virtual table per (tier, embedding model) pair for fast KNN retrieval.
 *
 * ## Why the index is namespaced by embedding model, not just by tier
 *
 * A vec0 table declares a fixed `float[N]` dimension at creation time. When a
 * user switches embedding providers (e.g. a 384-dim ONNX model → a 4096-dim
 * remote model), both vector shapes end up in the same base table. A single
 * per-tier index can only hold one of them: syncing to the new dimension drops
 * the old table, silently hiding every row still carrying the old vector.
 * Measured on a live store, that hid 276 of 288 semantic rows.
 *
 * Namespacing by model keeps each dimension's index independent, so rows
 * embedded under different models stay individually searchable while the
 * backfill gradually migrates them.
 *
 * ## Purge semantics
 *
 * `purgeAllVectorIndexes` drops every vec table AND sqlite-vec's shadow tables
 * (`_info`, `_chunks`, `_rowids`, `_vector_chunks00`). Dropping only the
 * virtual table leaves the shadow tables behind, so stale vector blobs keep
 * occupying the database file. A rebuild must therefore purge first, then let
 * the index repopulate from the base tables.
 *
 * ## Availability
 *
 * When the sqlite-vec extension is not loaded on the connection, every entry
 * point reports unavailable and callers fall back to brute-force cosine
 * scanning.
 */

export type VecTier = "episodic" | "semantic";

const BASE_TABLE: Record<VecTier, string> = {
  episodic: "episodic_memories",
  semantic: "semantic_memories",
};

/** vec0 table names are identifiers, so the model string must be sanitized. */
function sanitizeModelSuffix(model: string): string {
  const cleaned = model.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "unknown";
}

/** Namespaced vec0 table for one (tier, embedding model) pair. */
export function vectorTableFor(tier: VecTier, embeddingModel: string): string {
  return `${BASE_TABLE[tier]}_vec_${sanitizeModelSuffix(embeddingModel)}`;
}

/** Per-connection probe cache (the extension is loaded per connection). */
const vecAvailability = new WeakMap<Database.Database, boolean>();

/** True when the sqlite-vec extension is usable on this connection. */
export function isVectorIndexAvailable(sqlite: Database.Database): boolean {
  // Only cache positive probe results: a connection might load sqlite-vec
  // dynamically after the first probe (e.g. in test suites). Caching false
  // would permanently mark the connection as unavailable.
  if (vecAvailability.get(sqlite) === true) return true;
  try {
    // vec_version() only exists when the extension has been loaded.
    sqlite.prepare("SELECT vec_version() AS v").get();
    vecAvailability.set(sqlite, true);
    return true;
  } catch {
    return false;
  }
}

/** Dimension declared on an existing vec0 table, or null when absent. */
function getExistingVecDim(
  sqlite: Database.Database,
  vecTable: string
): number | null {
  const row = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(vecTable) as { sql?: string } | undefined;
  if (!row?.sql) return null;
  const match = row.sql.match(/float\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

/**
 * All live vec0 index tables (virtual tables only, excluding sqlite-vec's
 * internal shadow tables).
 */
export function listVectorIndexTables(sqlite: Database.Database): string[] {
  const rows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%vec0%'`
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Drops a vec0 table together with every shadow table sqlite-vec creates
 * alongside it. `DROP TABLE` on the virtual table alone does not remove the
 * `_info` / `_chunks` / `_rowids` / `_vector_chunks*` companions, so their
 * vector blobs would linger in the file.
 */
function dropVectorTable(sqlite: Database.Database, vecTable: string): void {
  const shadows = sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE name LIKE ? AND name NOT LIKE 'sqlite_%'`
    )
    .all(`${vecTable}%`) as Array<{ name: string }>;

  sqlite.exec(`DROP TABLE IF EXISTS ${vecTable}`);
  for (const shadow of shadows) {
    if (shadow.name === vecTable) continue;
    sqlite.exec(`DROP TABLE IF EXISTS ${shadow.name}`);
  }
}

/**
 * Deletes every vector index in the database, including sqlite-vec's shadow
 * tables. Called before a full rebuild so no stale vector data survives a
 * model change — an embedding model switch invalidates every stored vector,
 * and leaving the old index in place both wastes space and risks serving
 * incompatible vectors.
 *
 * Base tables are never touched; the indexes are rebuilt from them.
 *
 * @returns the number of vec0 tables purged.
 */
export function purgeAllVectorIndexes(sqlite: Database.Database): number {
  if (!isVectorIndexAvailable(sqlite)) return 0;

  const tables = listVectorIndexTables(sqlite);
  if (tables.length === 0) return 0;

  const purge = sqlite.transaction(() => {
    for (const table of tables) {
      dropVectorTable(sqlite, table);
    }
  });
  purge();

  return tables.length;
}

/**
 * Ensures the vec index for `tier` + `embeddingModel` exists at `dim`
 * dimensions and mirrors the matching rows of the base table.
 *
 * Only rows whose blob length equals `dim * 4` are indexed, so a table holding
 * vectors from several models keeps each dimension isolated. Returns false when
 * sqlite-vec is unavailable.
 */
export function syncVectorIndex(
  sqlite: Database.Database,
  tier: VecTier,
  dim: number,
  embeddingModel: string
): boolean {
  if (!isVectorIndexAvailable(sqlite)) return false;
  if (!Number.isInteger(dim) || dim <= 0) return false;

  const vecTable = vectorTableFor(tier, embeddingModel);
  const baseTable = BASE_TABLE[tier];
  const byteLength = dim * 4; // float32

  const existingDim = getExistingVecDim(sqlite, vecTable);
  if (existingDim !== dim) {
    dropVectorTable(sqlite, vecTable);
    sqlite.exec(
      `CREATE VIRTUAL TABLE ${vecTable} USING vec0(embedding float[${dim}] distance_metric=cosine)`
    );
  }

  const baseCount = (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM ${baseTable}
         WHERE embedding IS NOT NULL AND length(embedding) = ?`
      )
      .get(byteLength) as { n: number }
  ).n;

  const vecCount = (
    sqlite.prepare(`SELECT COUNT(*) AS n FROM ${vecTable}`).get() as {
      n: number;
    }
  ).n;

  // Verify whether base rowids match vec0 rowids (detects deletions + insertions with equal counts)
  let isDesynced = baseCount !== vecCount;
  if (!isDesynced && baseCount > 0) {
    const missingRowids = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM ${vecTable} v
           WHERE NOT EXISTS (
             SELECT 1 FROM ${baseTable} b
             WHERE b.rowid = v.rowid
               AND b.embedding IS NOT NULL
               AND length(b.embedding) = ?
           )`
        )
        .get(byteLength) as { n: number }
    ).n;
    if (missingRowids > 0) {
      isDesynced = true;
    }
  }

  if (isDesynced) {
    const rebuild = sqlite.transaction(() => {
      sqlite.exec(`DELETE FROM ${vecTable}`);
      sqlite
        .prepare(
          `INSERT INTO ${vecTable}(rowid, embedding)
           SELECT rowid, embedding FROM ${baseTable}
           WHERE embedding IS NOT NULL AND length(embedding) = ?`
        )
        .run(byteLength);
    });
    rebuild();
  }

  return true;
}

export interface VecHit {
  rowid: number;
  /** Cosine distance: similarity = 1 - distance. */
  distance: number;
}

/**
 * KNN search against the tier's vec index for `embeddingModel`. The index must
 * already be synced to `queryVector.length` dimensions via `syncVectorIndex`.
 */
export function vectorKnn(
  sqlite: Database.Database,
  tier: VecTier,
  embeddingModel: string,
  queryVector: Float32Array,
  limit: number
): VecHit[] {
  const vecTable = vectorTableFor(tier, embeddingModel);
  const queryBuffer = Buffer.from(
    queryVector.buffer,
    queryVector.byteOffset,
    queryVector.byteLength
  );
  return sqlite
    .prepare(
      `SELECT rowid, distance FROM ${vecTable}
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    )
    .all(queryBuffer, Math.max(1, limit)) as VecHit[];
}
