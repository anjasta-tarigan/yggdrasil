import type Database from "better-sqlite3";

/**
 * sqlite-vec backed vector index for the memory tables.
 *
 * The base tables (`episodic_memories`, `semantic_memories`) keep the
 * embedding BLOBs as the source of truth; this module maintains a `vec0`
 * virtual table per tier for fast KNN retrieval over ALL rows (the previous
 * brute-force scan only ever saw the newest 200 rows per tier).
 *
 * Design notes:
 *  - Tables are created with `distance_metric=cosine`, so
 *    `similarity = 1 - distance`.
 *  - The index dimension follows the live embedding model: it is derived
 *    from the query vector length. If the model (and therefore dimension)
 *    changes, the vec table is dropped and rebuilt — stale rows whose blob
 *    length no longer matches are excluded automatically.
 *  - Sync is count-based and self-healing: whenever the number of matching
 *    embedding rows in the base table differs from the vec table (new
 *    inserts, pruning by the decay sweep, dimension change), the index is
 *    rebuilt in one transaction. At personal-assistant scale this is
 *    milliseconds and needs no trigger bookkeeping.
 *  - When the sqlite-vec extension is not loaded on the connection, every
 *    entry point reports unavailable and callers fall back to brute-force
 *    cosine scanning.
 */

export type VecTier = "episodic" | "semantic";

const BASE_TABLE: Record<VecTier, string> = {
  episodic: "episodic_memories",
  semantic: "semantic_memories",
};

function vecTableFor(tier: VecTier): string {
  return `${BASE_TABLE[tier]}_vec`;
}

/** Per-connection probe cache (the extension is loaded per connection). */
const vecAvailability = new WeakMap<Database.Database, boolean>();

/** True when the sqlite-vec extension is usable on this connection. */
export function isVectorIndexAvailable(sqlite: Database.Database): boolean {
  const cached = vecAvailability.get(sqlite);
  if (cached !== undefined) return cached;
  let available = false;
  try {
    // vec_version() only exists when the extension has been loaded.
    sqlite.prepare("SELECT vec_version() AS v").get();
    available = true;
  } catch {
    available = false;
  }
  vecAvailability.set(sqlite, available);
  return available;
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
 * Ensures the vec index for `tier` exists at `dim` dimensions and mirrors
 * the base table. Returns false when sqlite-vec is unavailable.
 */
export function syncVectorIndex(
  sqlite: Database.Database,
  tier: VecTier,
  dim: number
): boolean {
  if (!isVectorIndexAvailable(sqlite)) return false;
  if (!Number.isInteger(dim) || dim <= 0) return false;

  const vecTable = vecTableFor(tier);
  const baseTable = BASE_TABLE[tier];
  const byteLength = dim * 4; // float32

  const existingDim = getExistingVecDim(sqlite, vecTable);
  if (existingDim !== dim) {
    sqlite.exec(`DROP TABLE IF EXISTS ${vecTable}`);
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
 * KNN search against the tier's vec index. The index must already be
 * synced to `queryVector.length` dimensions via `syncVectorIndex`.
 */
export function vectorKnn(
  sqlite: Database.Database,
  tier: VecTier,
  queryVector: Float32Array,
  limit: number
): VecHit[] {
  const vecTable = vecTableFor(tier);
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
