import type Database from "better-sqlite3";
import { isNotNull } from "drizzle-orm";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
} from "./embeddings";
import { syslog } from "@/lib/observability/log-store";
import {
  isVectorIndexAvailable,
  syncVectorIndex,
  vectorKnn,
  type VecTier,
} from "./vector-index";
import { rerankCandidates } from "./reranker";
import { env } from "@/env";

export type SearchResult = {
  id: string;
  type: "episodic" | "semantic";
  content: string;
  importance: number;
  score: number;
};

export type HybridSearchOptions = {
  limit?: number;
  rrfK?: number;
  embeddingModel?: string;
  db?: AppDatabase;
  sqlite?: Database.Database;
  /** Maximum milliseconds to wait for embedding generation before falling back to FTS-only (default: 800ms). */
  embeddingTimeoutMs?: number;
};

type FtsRow = {
  id: string;
  type: "episodic" | "semantic";
  content: string;
  importance: number;
};

/**
 * Sanitize user query string for safe FTS5 query tokenization.
 * Extracts unicode alphanumeric words and wraps them in quotes to avoid syntax errors
 * on hyphens, colons, parentheses, asterisks, etc. Supports non-Latin scripts (CJK, Cyrillic, Arabic, etc.).
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) || [];
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" ");
}

export async function hybridMemorySearch(
  query: string,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const k = options.rrfK ?? 60;
  const db = options.db ?? defaultDb;
  const sqlite = options.sqlite ?? defaultSqlite;

  const trimmedQuery = query?.trim() ?? "";
  if (!trimmedQuery) return [];

  const ftsQuery = sanitizeFtsQuery(trimmedQuery);

  // 1. FTS5 BM25 search (run independently for episodic and semantic)
  const episodicFtsHits: FtsRow[] = [];
  const semanticFtsHits: FtsRow[] = [];

  if (ftsQuery) {
    try {
      const epRows = sqlite
        .prepare(`
          SELECT e.id, 'episodic' as type, e.content, e.importance
          FROM episodic_memories_fts f
          JOIN episodic_memories e ON f.rowid = e.rowid
          WHERE episodic_memories_fts MATCH ?
          ORDER BY rank
          LIMIT 20
        `)
        .all(ftsQuery) as FtsRow[];
      episodicFtsHits.push(...epRows);

      const semRows = sqlite
        .prepare(`
          SELECT s.id, 'semantic' as type, s.content, s.importance
          FROM semantic_memories_fts f
          JOIN semantic_memories s ON f.rowid = s.rowid
          WHERE semantic_memories_fts MATCH ?
          ORDER BY rank
          LIMIT 20
        `)
        .all(ftsQuery) as FtsRow[];
      semanticFtsHits.push(...semRows);
    } catch (err) {
      syslog("warn", "search", `FTS query error: ${err}`);
    }
  }

  // 2. Vector search across ALL rows. sqlite-vec KNN is used when the
  //    extension is loaded on this connection; otherwise a brute-force
  //    cosine scan runs over the full tables. When the query cannot be
  //    embedded (endpoint down/unconfigured or slow) the vector channel is skipped
  //    entirely and FTS results alone are fused.
  const embeddingTimeout = options.embeddingTimeoutMs ?? 800;
  const embeddingPromise = generateEmbedding(query, options.embeddingModel);
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), embeddingTimeout)
  );
  const queryEmbedding = await Promise.race([embeddingPromise, timeoutPromise]);
  type VectorHit = {
    id: string;
    type: "episodic" | "semantic";
    content: string;
    importance: number;
    sim: number;
  };
  const episodicVectorHits: VectorHit[] = [];
  const semanticVectorHits: VectorHit[] = [];
  const pushToTier = (tier: "episodic" | "semantic", hit: VectorHit) =>
    (tier === "episodic" ? episodicVectorHits : semanticVectorHits).push(hit);

  if (queryEmbedding) {
    if (isVectorIndexAvailable(sqlite)) {
      const dim = queryEmbedding.length;
      for (const tier of ["episodic", "semantic"] as const satisfies VecTier[]) {
        if (!syncVectorIndex(sqlite, tier, dim)) continue;
        const baseTable =
          tier === "episodic" ? "episodic_memories" : "semantic_memories";
        for (const hit of vectorKnn(sqlite, tier, queryEmbedding, 50)) {
          const sim = 1 - hit.distance;
          if (sim <= 0.1) continue;
          const row = sqlite
            .prepare(
              `SELECT id, content, importance FROM ${baseTable} WHERE rowid = ?`
            )
            .get(hit.rowid) as
            | { id: string; content: string; importance: number }
            | undefined;
          if (!row) continue;
          pushToTier(tier, {
            id: row.id,
            type: tier,
            content: row.content,
            importance: row.importance,
            sim,
          });
        }
      }
    } else {
      // Brute-force fallback over the full tables with embedding IS NOT NULL filter
      const allEpisodes = await db
        .select({
          id: episodicMemories.id,
          content: episodicMemories.content,
          importance: episodicMemories.importance,
          embedding: episodicMemories.embedding,
        })
        .from(episodicMemories)
        .where(isNotNull(episodicMemories.embedding));

      for (const ep of allEpisodes) {
        if (ep.embedding) {
          const vec = bufferToVector(ep.embedding as Buffer);
          const sim = cosineSimilarity(queryEmbedding, vec);
          if (sim > 0.1) {
            episodicVectorHits.push({
              id: ep.id,
              type: "episodic",
              content: ep.content,
              importance: ep.importance,
              sim,
            });
          }
        }
      }

      const allSemantics = await db
        .select({
          id: semanticMemories.id,
          content: semanticMemories.content,
          importance: semanticMemories.importance,
          embedding: semanticMemories.embedding,
        })
        .from(semanticMemories)
        .where(isNotNull(semanticMemories.embedding));

      for (const sem of allSemantics) {
        if (sem.embedding) {
          const vec = bufferToVector(sem.embedding as Buffer);
          const sim = cosineSimilarity(queryEmbedding, vec);
          if (sim > 0.1) {
            semanticVectorHits.push({
              id: sem.id,
              type: "semantic",
              content: sem.content,
              importance: sem.importance,
              sim,
            });
          }
        }
      }
    }
  }

  // Sort each vector tier by similarity independently — RRF ranks must be
  // computed per tier or 20-row episodic KNN windows crowd semantic matches
  // out of the fused channel (the exact bias the fusion design forbids).
  episodicVectorHits.sort((a, b) => b.sim - a.sim);
  semanticVectorHits.sort((a, b) => b.sim - a.sim);

  // 3. Reciprocal Rank Fusion (RRF)
  const scoreMap = new Map<string, SearchResult>();

  const applyRankScore = (hits: Array<{ id: string; type: "episodic" | "semantic"; content: string; importance: number }>) => {
    hits.forEach((hit, rank) => {
      const rrfScore = 1 / (k + (rank + 1));
      const existing = scoreMap.get(hit.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scoreMap.set(hit.id, {
          id: hit.id,
          type: hit.type,
          content: hit.content,
          importance: hit.importance,
          score: rrfScore,
        });
      }
    });
  };

  // Rank channels independently to prevent episodic bias over semantic knowledge
  applyRankScore(episodicFtsHits);
  applyRankScore(semanticFtsHits);
  applyRankScore(episodicVectorHits);
  applyRankScore(semanticVectorHits);

  const fused = Array.from(scoreMap.values());
  // Adjust with importance boost
  fused.forEach((item) => {
    item.score *= 0.8 + 0.4 * item.importance;
  });

  fused.sort((a, b) => b.score - a.score);

  // 4. Optional selective reranking via bge-reranker-v2-m3 ONNX INT8.
  //
  // Only activates when RERANKER_ENABLED=true and RERANKER_MODEL_PATH is set.
  // Cross-encoders score query text against document text directly, so this
  // operates regardless of whether initial retrieval was vector or FTS-only.
  // Feeds the top candidates into the cross-encoder, min-max normalizes the
  // RRF scores across the candidate window to [0, 1], and blends (40% RRF,
  // 60% rerank) to preserve retrieval diversity while boosting relevance.
  // Falls back silently to pure-RRF ordering on any failure.
  let results: SearchResult[];
  if (env.RERANKER_ENABLED && fused.length > 0) {
    const candidateCount = Math.min(
      Math.max(env.RERANKER_CANDIDATE_WINDOW, limit),
      fused.length
    );
    const candidates = fused.slice(0, candidateCount);
    const reranked = await rerankCandidates(
      trimmedQuery,
      candidates.map((r) => ({ id: r.id, content: r.content }))
    );

    if (reranked) {
      // Min-max normalize RRF scores to [0, 1] within the candidate window
      // before blending with sigmoid rerank scores [0, 1]. Otherwise RRF's
      // ~0.02 scale is completely dwarfed by sigmoid's ~0.7 scale.
      const minRrf = Math.min(...candidates.map((c) => c.score));
      const maxRrf = Math.max(...candidates.map((c) => c.score));
      const rrfRange = maxRrf - minRrf || 1;

      const rerankScoreMap = new Map(reranked.map((r) => [r.id, r.rerankScore]));
      for (const item of candidates) {
        const rs = rerankScoreMap.get(item.id);
        if (rs !== undefined) {
          const normalizedRrf = (item.score - minRrf) / rrfRange;
          item.score = normalizedRrf * 0.4 + rs * 0.6;
        }
      }
      candidates.sort((a, b) => b.score - a.score);
    }

    results = candidates.slice(0, limit);
  } else {
    results = fused.slice(0, limit);
  }

  // Increment access counters so the Ebbinghaus decay formula in
  // compaction.ts (`+ 0.05 * LN(1 + access_count)`) actually has data to
  // work with. Previously these columns were never updated — the decay
  // boost was always `+0` regardless of how often a memory was retrieved.
  // Updates are best-effort: a failure to increment must never break
  // search results.
  if (results.length > 0) {
    void recordMemoryAccess(results, sqlite);
  }

  return results;
}

/**
 * Bumps `access_count` and `last_accessed_at` for a batch of search
 * results, split by memory type into single-statement IN-clause updates.
 * Fire-and-forget: callers must not await or depend on this.
 */
async function recordMemoryAccess(
  results: { id: string; type: "episodic" | "semantic" }[],
  sqlite: Database.Database
): Promise<void> {
  const episodicIds = results
    .filter((r) => r.type === "episodic")
    .map((r) => r.id);
  const semanticIds = results
    .filter((r) => r.type === "semantic")
    .map((r) => r.id);

  try {
    if (episodicIds.length > 0) {
      const placeholders = episodicIds.map(() => "?").join(",");
      sqlite
        .prepare(
          `UPDATE episodic_memories SET access_count = access_count + 1, last_accessed_at = strftime('%s', 'now') WHERE id IN (${placeholders})`
        )
        .run(...episodicIds);
    }
    if (semanticIds.length > 0) {
      const placeholders = semanticIds.map(() => "?").join(",");
      sqlite
        .prepare(
          `UPDATE semantic_memories SET access_count = access_count + 1, last_accessed_at = strftime('%s', 'now') WHERE id IN (${placeholders})`
        )
        .run(...semanticIds);
    }
  } catch (err) {
    syslog("warn", "search", `Failed to update memory access counts: ${err}`);
  }
}

