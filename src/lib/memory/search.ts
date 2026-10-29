import type { CompatDatabaseSync } from "@/db/compat";
import { sqlite as defaultSqlite, type AppDatabase } from "@/db";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
  resolveEmbeddingModel,
  getEmbeddingConfigFromRegistry,
  isNvidiaEmbeddingEndpoint,
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
  /** Memory tags for caller-side filtering (e.g., excluding ephemeral memories). */
  tags?: string[] | null;
};

export type HybridSearchOptions = {
  limit?: number;
  /** RRF k constant (legacy: overrides both channel-specific k values). */
  rrfK?: number;
  /** RRF k for FTS5 channel (default: 20, more aggressive rank penalty). */
  rrfKfts?: number;
  /** RRF k for vector channel (default: 60, standard RRF). */
  rrfKvec?: number;
  /** Weight multiplier for FTS RRF contribution (default: 1.3, boosts keyword matches without reranker). */
  rrfFtsWeight?: number;
  /** Weight multiplier for vector RRF contribution (default: 1.0). */
  rrfVecWeight?: number;
  embeddingModel?: string;
  db?: AppDatabase;
  sqlite?: CompatDatabaseSync;
  /** Maximum milliseconds to wait for embedding generation before falling back to FTS-only (default: 800ms). */
  embeddingTimeoutMs?: number;
  /** Enable graph relation expansion across memory_relations (default: true). */
  enableGraphAugmentation?: boolean;
  /** Maximum graph neighbors to expand per seed hit (default: 3). */
  maxGraphNeighborsPerHit?: number;
  /** Maximum graph traversal hops (default: 2). */
  maxGraphHops?: number;
};

type FtsRow = {
  id: string;
  type: "episodic" | "semantic";
  content: string;
  importance: number;
  /** Raw JSON text from SQLite (parsed by parseTags before use). */
  tags: string | null;
  /** BM25 score (negative; lower = better match). Uses snake_case to match SQLite column name. */
  bm25_score?: number | null;
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

/**
 * Build an FTS5 phrase query by joining sanitized tokens into a phrase.
 * Phrase matching requires all terms to appear in order and adjacently,
 * which boosts precision for multi-word queries (e.g. "Docker config"
 * won't match a document that mentions Docker and config in separate paragraphs).
 * Returns "" when fewer than 2 tokens are present (no benefit from phrase).
 */
function buildFtsPhraseQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) || [];
  if (tokens.length < 2) return "";
  return `"${tokens.join(" ")}"`;
}

/**
 * Build an FTS5 NEAR query: NEAR(token1 token2, N) finds documents where
 * all terms appear within N tokens of each other (any order). This is a
 * precision-boosting middle ground between bag-of-words (any distance) and
 * phrase matching (exact adjacency). Returns "" when fewer than 2 tokens.
 */
function buildFtsNearQuery(query: string, window: number): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) || [];
  if (tokens.length < 2) return "";
  return `NEAR(${tokens.map((t) => `"${t}"`).join(" ")}, ${window})`;
}

/**
 * Parse a raw SQLite JSON-tags column value into a string array.
 * FTS and graph queries return raw text (JSON string) from better-sqlite3,
 * while Drizzle queries with mode:"json" return already-parsed arrays.
 * This normalizes both to string[].
 */
function parseTags(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as string[] : undefined;
  } catch (err) {
    syslog("debug", "search", `Error: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * 2-Hop Graph-Augmented RAG:
 * For the top direct retrieval hits, traverses associative and causal links in
 * `memory_relations` up to 2 hops deep with exponential damping, cycle prevention,
 * and a strict 20-candidate global ceiling with early-exit.
 */
type Hop1Candidate = {
  hit: SearchResult;
  parentIds: Set<string>;
};

export function expandGraphNeighbors(
  seedHits: SearchResult[],
  scoreMap: Map<string, SearchResult>,
  sqlite: CompatDatabaseSync,
  maxNeighborsPerHit = 3,
  maxHops = 2
): void {
  if (seedHits.length === 0 || maxHops <= 0) return;

  const MAX_GRAPH_CANDIDATES = 20;
  let graphCandidatesAdded = 0;
  const expandedIds = new Set<string>();
  const hop1Nodes: Hop1Candidate[] = [];
  const hop1NodeMap = new Map<string, Hop1Candidate>();

  try {
    const relStmt = sqlite.prepare(`
      SELECT
        CASE WHEN from_memory_id = ? THEN to_memory_id ELSE from_memory_id END as neighbor_id,
        CASE WHEN from_memory_id = ? THEN to_memory_type ELSE from_memory_type END as neighbor_type,
        relation_type,
        strength
      FROM memory_relations
      WHERE (from_memory_id = ? OR to_memory_id = ?)
        AND relation_type != 'superseded_by'
      ORDER BY strength DESC
      LIMIT ?
    `);

    const semStmt = sqlite.prepare(
      "SELECT id, content, importance, tags, metadata FROM semantic_memories WHERE id = ?"
    );
    const epStmt = sqlite.prepare(
      "SELECT id, content, importance, tags, metadata FROM episodic_memories WHERE id = ?"
    );
    const isSupersededRelStmt = sqlite.prepare(
      "SELECT 1 FROM memory_relations WHERE from_memory_id = ? AND relation_type = 'superseded_by' LIMIT 1"
    );

    const isSuperseded = (id: string, metadataRaw?: string | null): boolean => {
      if (metadataRaw) {
        try {
          const meta = typeof metadataRaw === "string" ? JSON.parse(metadataRaw) : metadataRaw;
          if (meta?.superseded === true) return true;
        } catch (err) {
          syslog("debug", "search", `Error: ${err instanceof Error ? err.message : String(err)}`);
          // malformed json; fall through to relation check
        }
      }
      return isSupersededRelStmt.get(id) !== undefined;
    };

    // --- Hop 1: Direct neighbors of seed hits ---
    for (const seed of seedHits) {
      if (graphCandidatesAdded >= MAX_GRAPH_CANDIDATES) break;
      if (expandedIds.has(seed.id)) continue;
      expandedIds.add(seed.id);

      const neighbors = relStmt.all(
        seed.id,
        seed.id,
        seed.id,
        seed.id,
        maxNeighborsPerHit
      ) as Array<{
        neighbor_id: string;
        neighbor_type: "episodic" | "semantic" | "working";
        relation_type: string;
        strength: number;
      }>;

      for (const n of neighbors) {
        if (n.neighbor_type === "working") continue;
        if (n.neighbor_id === seed.id) continue;

        const relStrength = Number(n.strength) || 0.5;
        const incoming = seed.score * relStrength;

        const existing = scoreMap.get(n.neighbor_id);
        if (existing) {
          // Boost existing candidate through graph consensus
          existing.score += incoming * 0.3;
          const candidate = hop1NodeMap.get(n.neighbor_id);
          if (candidate) {
            candidate.parentIds.add(seed.id);
          }
        } else {
          if (graphCandidatesAdded >= MAX_GRAPH_CANDIDATES) break;

          const nodeRow = (
            n.neighbor_type === "semantic"
              ? semStmt.get(n.neighbor_id)
              : epStmt.get(n.neighbor_id)
          ) as { id: string; content: string; importance: number; tags: string | null; metadata?: string | null } | undefined;

          if (nodeRow && !isSuperseded(nodeRow.id, nodeRow.metadata)) {
            // Hop 1 propagated score: damping 0.5
            const propScore = incoming * 0.5 * (0.8 + 0.4 * nodeRow.importance);
            const hit: SearchResult = {
              id: nodeRow.id,
              type: n.neighbor_type,
              content: nodeRow.content,
              importance: nodeRow.importance,
              tags: parseTags(nodeRow.tags),
              score: propScore,
            };
            scoreMap.set(nodeRow.id, hit);
            graphCandidatesAdded++;

            const candidate: Hop1Candidate = {
              hit,
              parentIds: new Set([seed.id]),
            };
            hop1Nodes.push(candidate);
            hop1NodeMap.set(nodeRow.id, candidate);

            if (graphCandidatesAdded >= MAX_GRAPH_CANDIDATES) break;
          }
        }
      }
    }

    // --- Hop 2: Associative chaining from newly reached Hop 1 nodes ---
    // Early exit if budget reached or no Hop 1 nodes.
    if (
      maxHops < 2 ||
      graphCandidatesAdded >= MAX_GRAPH_CANDIDATES ||
      hop1Nodes.length === 0
    ) {
      return;
    }

    const hop2Limit = Math.min(2, maxNeighborsPerHit);

    for (const h1 of hop1Nodes) {
      if (graphCandidatesAdded >= MAX_GRAPH_CANDIDATES) break;
      if (expandedIds.has(h1.hit.id)) continue;
      expandedIds.add(h1.hit.id);

      const neighbors = relStmt.all(
        h1.hit.id,
        h1.hit.id,
        h1.hit.id,
        h1.hit.id,
        hop2Limit + h1.parentIds.size
      ) as Array<{
        neighbor_id: string;
        neighbor_type: "episodic" | "semantic" | "working";
        relation_type: string;
        strength: number;
      }>;

      let hop2CountForH1 = 0;
      for (const n of neighbors) {
        if (n.neighbor_type === "working") continue;
        if (n.neighbor_id === h1.hit.id) continue;
        if (h1.parentIds.has(n.neighbor_id)) continue; // avoid boosting immediate parent reverse-edge

        const relStrength = Number(n.strength) || 0.5;
        const incoming = h1.hit.score * relStrength;

        const existing = scoreMap.get(n.neighbor_id);
        if (existing) {
          // Hop 2 consensus boost also uses incoming * 0.3
          existing.score += incoming * 0.3;
          hop2CountForH1++;
          if (hop2CountForH1 >= hop2Limit) break;
        } else {
          if (graphCandidatesAdded >= MAX_GRAPH_CANDIDATES) break;

          const nodeRow = (
            n.neighbor_type === "semantic"
              ? semStmt.get(n.neighbor_id)
              : epStmt.get(n.neighbor_id)
          ) as { id: string; content: string; importance: number; tags: string | null; metadata?: string | null } | undefined;

          if (nodeRow && !isSuperseded(nodeRow.id, nodeRow.metadata)) {
            // Hop 2 propagated score: damping 0.35
            const propScore = incoming * 0.35 * (0.8 + 0.4 * nodeRow.importance);
            scoreMap.set(nodeRow.id, {
              id: nodeRow.id,
              type: n.neighbor_type,
              content: nodeRow.content,
              importance: nodeRow.importance,
              tags: parseTags(nodeRow.tags),
              score: propScore,
            });
            graphCandidatesAdded++;
            hop2CountForH1++;
            if (graphCandidatesAdded >= MAX_GRAPH_CANDIDATES || hop2CountForH1 >= hop2Limit) break;
          }
        }
      }
    }
  } catch (err) {
    // Non-fatal: graph augmentation is an enhancement over the direct hits, so
    // a failure here degrades ranking rather than corrupting results. Log at
    // warn (not debug) so a persistently failing graph layer is visible, and
    // keep the direct hits intact for the caller.
    syslog("warn", "search", `expandGraphNeighbors failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function hybridMemorySearch(
  query: string,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  // Channel-specific RRF configuration. When no reranker is available, FTS
  // gets a smaller k (more aggressive rank penalty) and a weight boost to
  // favor precise keyword matches. Vector search uses standard k=60.
  const rrfKfts = options.rrfKfts ?? options.rrfK ?? env.MEMORY_SEARCH_RRF_K_FTS;
  const rrfKvec = options.rrfKvec ?? options.rrfK ?? env.MEMORY_SEARCH_RRF_K_VEC;
  const rrfFtsWeight = options.rrfFtsWeight ?? env.MEMORY_SEARCH_RRF_FTS_WEIGHT;
  const rrfVecWeight = options.rrfVecWeight ?? env.MEMORY_SEARCH_RRF_VEC_WEIGHT;
  const sqlite = options.sqlite ??
    (options.db as unknown as { $client?: CompatDatabaseSync } | undefined)?.$client ??
    defaultSqlite;

  const trimmedQuery = query?.trim() ?? "";
  if (!trimmedQuery) return [];

  const ftsQuery = sanitizeFtsQuery(trimmedQuery);

  // 1. FTS5 BM25 search (run independently for episodic and semantic)
  //    Includes bm25() score for score-aware RRF fusion.
  const episodicFtsHits: FtsRow[] = [];
  const semanticFtsHits: FtsRow[] = [];

  if (ftsQuery) {
    try {
      const epRows = sqlite
        .prepare(`
          SELECT e.id, 'episodic' as type, e.content, e.importance, e.tags as tags,
                 bm25(episodic_memories_fts) as bm25_score
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
          SELECT s.id, 'semantic' as type, s.content, s.importance, s.tags as tags,
                 bm25(semantic_memories_fts) as bm25_score
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

    // 1b. Phrase query for multi-word queries — boosts precision on exact
    //     multi-term matches that bag-of-words tokenization would split.
    //     Phrase results are merged with a slight rank penalty (0.5 added to
    //     the BM25 score, making them rank lower than strong bag-of-words
    //     hits but still contributing to the RRF fusion).
    const phraseQuery = buildFtsPhraseQuery(trimmedQuery);
    // Sets to track which IDs are already found by bag-of-words and phrase
    // queries, so NEAR results don't duplicate them.
    const epIds = new Set(episodicFtsHits.map((h) => h.id));
    const semIds = new Set(semanticFtsHits.map((h) => h.id));
    if (phraseQuery && phraseQuery !== ftsQuery) {
      try {
        const phraseEpRows = sqlite
          .prepare(`
            SELECT e.id, 'episodic' as type, e.content, e.importance, e.tags as tags,
                   bm25(episodic_memories_fts) as bm25_score
            FROM episodic_memories_fts f
            JOIN episodic_memories e ON f.rowid = e.rowid
            WHERE episodic_memories_fts MATCH ?
            ORDER BY rank
            LIMIT 5
          `)
          .all(phraseQuery) as FtsRow[];
        for (const row of phraseEpRows) {
          if (!epIds.has(row.id)) {
            episodicFtsHits.push({
              ...row,
              bm25_score: (row.bm25_score ?? 0) - 0.5,
            });
          }
        }

        const phraseSemRows = sqlite
          .prepare(`
            SELECT s.id, 'semantic' as type, s.content, s.importance, s.tags as tags,
                   bm25(semantic_memories_fts) as bm25_score
            FROM semantic_memories_fts f
            JOIN semantic_memories s ON f.rowid = s.rowid
            WHERE semantic_memories_fts MATCH ?
            ORDER BY rank
            LIMIT 5
          `)
          .all(phraseQuery) as FtsRow[];
        for (const row of phraseSemRows) {
          if (!semIds.has(row.id)) {
            semanticFtsHits.push({
              ...row,
              bm25_score: (row.bm25_score ?? 0) - 0.5,
            });
          }
        }
      } catch (err) {
        syslog("debug", "search", `Phrase FTS query error: ${err}`);
      }
    }

    // 1c. NEAR query for multi-word queries — a precision-boosting middle
    //     ground between bag-of-words (any distance) and phrase (exact
    //     adjacency). Finds documents where all terms appear within
    //     MEMORY_SEARCH_NEAR_WINDOW tokens of each other. Only added when
    //     the phrase query didn't already cover these documents, avoiding
    //     double-counting the strongest matches.
    const nearWindow = env.MEMORY_SEARCH_NEAR_WINDOW;
    if (nearWindow > 0 && phraseQuery && phraseQuery !== ftsQuery) {
      const nearQuery = buildFtsNearQuery(trimmedQuery, nearWindow);
      if (nearQuery) {
        try {
          const nearEpRows = sqlite
            .prepare(`
              SELECT e.id, 'episodic' as type, e.content, e.importance, e.tags as tags,
                     bm25(episodic_memories_fts) as bm25_score
              FROM episodic_memories_fts f
              JOIN episodic_memories e ON f.rowid = e.rowid
              WHERE episodic_memories_fts MATCH ?
              ORDER BY rank
              LIMIT 10
            `)
            .all(nearQuery) as FtsRow[];
          for (const row of nearEpRows) {
            if (!epIds.has(row.id)) {
              episodicFtsHits.push({
                ...row,
                bm25_score: (row.bm25_score ?? 0) - 0.3, // Small penalty vs. exact phrase
              });
            }
          }

          const nearSemRows = sqlite
            .prepare(`
              SELECT s.id, 'semantic' as type, s.content, s.importance, s.tags as tags,
                     bm25(semantic_memories_fts) as bm25_score
              FROM semantic_memories_fts f
              JOIN semantic_memories s ON f.rowid = s.rowid
              WHERE semantic_memories_fts MATCH ?
              ORDER BY rank
              LIMIT 10
            `)
            .all(nearQuery) as FtsRow[];
          for (const row of nearSemRows) {
            if (!semIds.has(row.id)) {
              semanticFtsHits.push({
                ...row,
                bm25_score: (row.bm25_score ?? 0) - 0.3,
              });
            }
          }
        } catch (err) {
          syslog("debug", "search", `NEAR FTS query error: ${err}`);
        }
      }
    }
  }

  // 2. Vector search across ALL rows. sqlite-vec KNN is used when the
  //    extension is loaded on this connection; otherwise a brute-force
  //    cosine scan runs over the full tables. When the query cannot be
  //    embedded (endpoint down/unconfigured or slow) the vector channel is skipped
  //    entirely and FTS results alone are fused.
  const embeddingTimeout = options.embeddingTimeoutMs ?? 800;
  // NVIDIA asymmetric models need input_type="query" for search embeddings.
  // Detect the saved endpoint; non-NVIDIA endpoints ignore the field.
  let queryInputType: "query" | undefined;
  try {
    const cfg = await getEmbeddingConfigFromRegistry();
    if (cfg.baseUrl && isNvidiaEmbeddingEndpoint(cfg.baseUrl)) {
      queryInputType = "query";
    }
  } catch {
    // Config read failure: fall back to no inputType (default behavior).
  }
  const embeddingPromise = generateEmbedding(
    query,
    options.embeddingModel,
    queryInputType
  );
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), embeddingTimeout);
  });
  let queryEmbedding: Float32Array | null = null;
  try {
    queryEmbedding = await Promise.race([embeddingPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  type VectorHit = {
    id: string;
    type: "episodic" | "semantic";
    content: string;
    importance: number;
    tags: string[] | null;
    sim: number;
  };
  const episodicVectorHits: VectorHit[] = [];
  const semanticVectorHits: VectorHit[] = [];
  const pushToTier = (tier: "episodic" | "semantic", hit: VectorHit) =>
    (tier === "episodic" ? episodicVectorHits : semanticVectorHits).push(hit);

  if (queryEmbedding) {
    if (isVectorIndexAvailable(sqlite)) {
      const dim = queryEmbedding.length;
      // The index is namespaced by embedding model: rows embedded under a
      // different model live in their own vec table at their own dimension, so
      // a model switch never hides the previous model's rows from this query.
      const embeddingModel = await resolveEmbeddingModel(options.embeddingModel);
      for (const tier of ["episodic", "semantic"] as const satisfies VecTier[]) {
        if (!syncVectorIndex(sqlite, tier, dim, embeddingModel)) continue;
        const baseTable =
          tier === "episodic" ? "episodic_memories" : "semantic_memories";
        for (const hit of vectorKnn(sqlite, tier, embeddingModel, queryEmbedding, 50)) {
          const sim = 1 - hit.distance;
          if (sim <= 0.1) continue;
          const row = sqlite
            .prepare(
              `SELECT id, content, importance, tags FROM ${baseTable} WHERE rowid = ?`
            )
            .get(hit.rowid) as
            | { id: string; content: string; importance: number; tags: string[] | null }
            | undefined;
          if (!row) continue;
          pushToTier(tier, {
            id: row.id,
            type: tier,
            content: row.content,
            importance: row.importance,
            tags: row.tags,
            sim,
          });
        }
      }
    } else {
      // Brute-force fallback over the full tables with embedding IS NOT NULL filter
      const embeddingModel = await resolveEmbeddingModel(options.embeddingModel);
      for (const tier of ["episodic", "semantic"] as const) {
        const table = tier === "episodic" ? "episodic_memories" : "semantic_memories";
        const hits = tier === "episodic" ? episodicVectorHits : semanticVectorHits;
        const rows = sqlite.prepare(
          `SELECT id, content, importance, tags, embedding FROM ${table}
           WHERE embedding_model = ? AND embedding IS NOT NULL AND length(embedding) = ?`
        ).iterate(embeddingModel, queryEmbedding.length * Float32Array.BYTES_PER_ELEMENT);
        for (const row of rows) {
          const memory = row as { id: string; content: string; importance: number; tags: string[] | null; embedding: Buffer };
          const sim = cosineSimilarity(queryEmbedding, bufferToVector(memory.embedding));
          if (sim <= 0.1) continue;
          hits.push({ id: memory.id, type: tier, content: memory.content, importance: memory.importance, tags: memory.tags, sim });
          if (hits.length > 50) {
            hits.sort((a, b) => b.sim - a.sim);
            hits.pop();
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

  // 3. Reciprocal Rank Fusion (RRF) with channel-specific k and weights.
  //
  // Strategy (no reranker available):
  //   - FTS uses a smaller k (default 20) so lower-ranked keyword hits are
  //     penalized more aggressively — keyword precision is higher but noisier.
  //   - Vector uses standard k (default 60) — semantic recall is valued.
  //   - FTS gets a weight boost (default 1.3) to compensate for its smaller k
  //     and emphasize exact-match confidence.
  //   - BM25 scores are normalized to [0, 1] and blended (α from env) into the
  //     RRF score so strong matches at a given rank get a slight edge.
  //   - Importance is boosted inline (β from env) so high-importance memories
  //     float even at the same rank position.
  const bm25Blend = env.MEMORY_SEARCH_BM25_BLEND;
  const importanceBoost = env.MEMORY_SEARCH_IMPORTANCE_BOOST;
  const scoreMap = new Map<string, SearchResult>();

  // Normalize BM25 scores within each channel to [0, 1].
  // BM25 returns negative values where lower = better, so we invert.
  function normalizeBm25(hits: FtsRow[]): number[] {
    if (hits.length === 0) return [];
    const scores = hits.map((h) => -(h.bm25_score ?? 0));
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    return scores.map((s) => (s - min) / range);
  }

  const epFtsNorm = normalizeBm25(episodicFtsHits);
  const semFtsNorm = normalizeBm25(semanticFtsHits);

  const applyRankScore = (
    hits: Array<{ id: string; type: "episodic" | "semantic"; content: string; importance: number; tags?: string[] | null | string; sim?: number }>,
    channelK: number,
    channelWeight: number,
    bm25Scores?: number[]
  ) => {
    hits.forEach((hit, rank) => {
      const rrfScore = 1 / (channelK + (rank + 1));
      // BM25 boost: configurable blend of normalized BM25 score for FTS channels.
      const bm25Boost = bm25Scores ? bm25Scores[rank] * bm25Blend : 0;
      // Importance pre-boost: configurable factor so high-importance memories float.
      const impBoost = importanceBoost * ((hit.importance ?? 0.5) - 0.5);
      const weightedScore = (rrfScore * (1 + bm25Boost) + impBoost) * channelWeight;
      const existing = scoreMap.get(hit.id);
      if (existing) {
        existing.score += weightedScore;
      } else {
        scoreMap.set(hit.id, {
          id: hit.id,
          type: hit.type,
          content: hit.content,
          importance: hit.importance,
          tags: parseTags(hit.tags),
          score: weightedScore,
        });
      }
    });
  };

  // Rank channels independently to prevent episodic bias over semantic knowledge
  applyRankScore(episodicFtsHits, rrfKfts, rrfFtsWeight, epFtsNorm);
  applyRankScore(semanticFtsHits, rrfKfts, rrfFtsWeight, semFtsNorm);
  applyRankScore(episodicVectorHits, rrfKvec, rrfVecWeight);
  applyRankScore(semanticVectorHits, rrfKvec, rrfVecWeight);

  let fused = Array.from(scoreMap.values());
  fused.sort((a, b) => b.score - a.score);

  // 3.5. Graph-Augmented RAG: Multi-hop associative relation expansion
  const enableGraph = options.enableGraphAugmentation ?? true;
  if (enableGraph && fused.length > 0) {
    const seedWindow = fused.slice(0, Math.min(5, fused.length));
    expandGraphNeighbors(
      seedWindow,
      scoreMap,
      sqlite,
      options.maxGraphNeighborsPerHit ?? 3,
      options.maxGraphHops ?? 2
    );
  }

  // Exclude superseded memories that have been invalidated by newer facts
  try {
    const supersededRows = sqlite
      .prepare(
        "SELECT from_memory_id FROM memory_relations WHERE relation_type = 'superseded_by'"
      )
      .all() as Array<{ from_memory_id: string }>;

    for (const row of supersededRows) {
      scoreMap.delete(row.from_memory_id);
    }

    const checkMetaStmt = sqlite.prepare(`
      SELECT metadata FROM semantic_memories WHERE id = ?
      UNION ALL
      SELECT metadata FROM episodic_memories WHERE id = ?
    `);

    for (const [id] of scoreMap) {
      const metaRow = checkMetaStmt.get(id, id) as { metadata?: string | null } | undefined;
      if (metaRow?.metadata) {
        try {
          const meta = typeof metaRow.metadata === "string" ? JSON.parse(metaRow.metadata) : metaRow.metadata;
          if (meta?.superseded === true) {
            scoreMap.delete(id);
          }
        } catch (err) {
          syslog("debug", "search", `Error: ${err instanceof Error ? err.message : String(err)}`);
          // ignore malformed metadata
        }
      }
    }
  } catch (err) {
    syslog("debug", "search", `superseded check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  fused = Array.from(scoreMap.values());
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
  sqlite: CompatDatabaseSync
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

