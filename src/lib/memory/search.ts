import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { episodicMemories, semanticMemories } from "@/db/schema";
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
  db?: AppDatabase;
  sqlite?: Database.Database;
};

type FtsRow = {
  id: string;
  type: "episodic" | "semantic";
  content: string;
  importance: number;
};

export async function hybridMemorySearch(
  query: string,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const k = options.rrfK ?? 60;
  const db = options.db ?? defaultDb;
  const sqlite = options.sqlite ?? defaultSqlite;

  const sanitizedQuery = query.replace(/['"*]/g, " ").trim();
  if (!sanitizedQuery) return [];

  // 1. FTS5 BM25 search
  const ftsHits: FtsRow[] = [];
  try {
    const episodicFts = sqlite
      .prepare(`
        SELECT e.id, 'episodic' as type, e.content, e.importance
        FROM episodic_memories_fts f
        JOIN episodic_memories e ON f.rowid = e.rowid
        WHERE episodic_memories_fts MATCH ?
        ORDER BY rank
        LIMIT 20
      `)
      .all(sanitizedQuery) as FtsRow[];
    ftsHits.push(...episodicFts);

    const semanticFts = sqlite
      .prepare(`
        SELECT s.id, 'semantic' as type, s.content, s.importance
        FROM semantic_memories_fts f
        JOIN semantic_memories s ON f.rowid = s.rowid
        WHERE semantic_memories_fts MATCH ?
        ORDER BY rank
        LIMIT 20
      `)
      .all(sanitizedQuery) as FtsRow[];
    ftsHits.push(...semanticFts);
  } catch (err) {
    console.warn("[search] FTS query error:", err);
  }

  // 2. Vector search (in-memory cosine over rows with embeddings)
  const queryEmbedding = await generateEmbedding(query);
  const vectorHits: Array<{
    id: string;
    type: "episodic" | "semantic";
    content: string;
    importance: number;
    sim: number;
  }> = [];

  const allEpisodes = await db.select().from(episodicMemories).limit(100);
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

  const allSemantics = await db.select().from(semanticMemories).limit(100);
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

  ftsHits.forEach((hit, rank) => {
    const rrfScore = 1 / (k + (rank + 1));
    scoreMap.set(hit.id, {
      id: hit.id,
      type: hit.type,
      content: hit.content,
      importance: hit.importance,
      score: rrfScore,
    });
  });

  vectorHits.forEach((hit, rank) => {
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

  const fused = Array.from(scoreMap.values());
  // Adjust with importance boost
  fused.forEach((item) => {
    item.score *= 0.8 + 0.4 * item.importance;
  });

  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, limit);
}
