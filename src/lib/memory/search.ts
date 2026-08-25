import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
import { desc } from "drizzle-orm";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
} from "./embeddings";

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
 * Extracts alphanumeric words and wraps them in quotes to avoid syntax errors
 * on hyphens, colons, parentheses, asterisks, etc.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[a-zA-Z0-9_À-ſ]+/g) || [];
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

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  // 1. FTS5 BM25 search (run independently for episodic and semantic)
  const episodicFtsHits: FtsRow[] = [];
  const semanticFtsHits: FtsRow[] = [];

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

  // 2. Vector search (fetch recent high-importance candidates and compute cosine similarity)
  const queryEmbedding = await generateEmbedding(query, options.embeddingModel);
  const vectorHits: Array<{
    id: string;
    type: "episodic" | "semantic";
    content: string;
    importance: number;
    sim: number;
  }> = [];

  const allEpisodes = await db
    .select()
    .from(episodicMemories)
    .orderBy(desc(episodicMemories.createdAt))
    .limit(200);

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
    .select()
    .from(semanticMemories)
    .orderBy(desc(semanticMemories.updatedAt))
    .limit(200);

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

