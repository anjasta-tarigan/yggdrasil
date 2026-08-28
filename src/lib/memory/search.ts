import type Database from "better-sqlite3";
import { isNotNull } from "drizzle-orm";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
} from "./embeddings";
import {
  isVectorIndexAvailable,
  syncVectorIndex,
  vectorKnn,
  type VecTier,
} from "./vector-index";

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
      console.warn("[search] FTS query error:", err);
    }
  }

  // 2. Vector search across ALL rows. sqlite-vec KNN is used when the
  //    extension is loaded on this connection; otherwise a brute-force
  //    cosine scan runs over the full tables. When the query cannot be
  //    embedded (endpoint down/unconfigured) the vector channel is skipped
  //    entirely and FTS results alone are fused.
  const queryEmbedding = await generateEmbedding(query, options.embeddingModel);
  const vectorHits: Array<{
    id: string;
    type: "episodic" | "semantic";
    content: string;
    importance: number;
    sim: number;
  }> = [];

  if (queryEmbedding) {
    if (isVectorIndexAvailable(sqlite)) {
      const dim = queryEmbedding.length;
      for (const tier of ["episodic", "semantic"] as const satisfies VecTier[]) {
        if (!syncVectorIndex(sqlite, tier, dim)) continue;
        const baseTable =
          tier === "episodic" ? "episodic_memories" : "semantic_memories";
        for (const hit of vectorKnn(sqlite, tier, queryEmbedding, 20)) {
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
          vectorHits.push({
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
            vectorHits.push({
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
            vectorHits.push({
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

  vectorHits.sort((a, b) => b.sim - a.sim);

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
  applyRankScore(vectorHits);

  const fused = Array.from(scoreMap.values());
  // Adjust with importance boost
  fused.forEach((item) => {
    item.score *= 0.8 + 0.4 * item.importance;
  });

  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, limit);
}

