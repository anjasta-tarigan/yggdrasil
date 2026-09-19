import { nanoid } from "nanoid";
import { and, eq, isNotNull, isNull, notLike, or } from "drizzle-orm";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { semanticMemories, memoryRelations } from "@/db/schema";
import { bufferToVector, cosineSimilarity, vectorToBuffer } from "./embeddings";
import type { SemanticMemoryInput, MemoryRelationInput } from "./types";
import {
  isVectorIndexAvailable,
  syncVectorIndex,
  vectorTableFor,
} from "./vector-index";
import type Database from "better-sqlite3";

/**
 * Cosine similarity at or above this value is treated as the same fact.
 * Re-extracted duplicates are merged into the existing row instead of
 * creating a new one, so repeated reflections/consolidations reinforce a
 * memory rather than polluting retrieval with near-identical copies.
 *
 * Calibrated empirically against a live 296-row store on a 384-dim model
 * (Xenova/multilingual-e5-small): 445 row pairs sat in the 0.90–0.95 band and
 * were all boilerplate-sharing session summaries of the same underlying facts.
 * The previous 0.95 gate let every one of them accumulate as a separate row.
 * Genuinely distinct facts measured at ≈0.75, so 0.90 keeps a clear margin.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.90;

/**
 * Calibrated passive contradiction detection window floor.
 * Facts within [0.78, 0.90) similarity in the same category are inspected for
 * conflicting preferences/predicates. Below 0.78 represents independent domain facts.
 */
export const CONTRADICTION_SIMILARITY_MIN = 0.78;

/**
 * Cosine-distance ceiling for the vec0 KNN duplicate probe.
 * distance = 1 - similarity → 0.10 ≈ similarity 0.90.
 */
const NEAR_DUPLICATE_DISTANCE = 1 - NEAR_DUPLICATE_THRESHOLD;

/**
 * Jaccard floor for the lexical duplicate fallback, used when a vector
 * comparison is impossible (either row has no embedding).
 *
 * Long LLM summaries share a boilerplate preamble ("## Key Facts &
 * Preferences", "**User Profile:**") while their bodies differ. Raw token
 * overlap therefore inflates; the floor is set at 0.85 to require near-identical
 * wording before merging, so distinct facts that merely share a template stay
 * separate.
 */
export const LEXICAL_DUPLICATE_THRESHOLD = 0.85;

/**
 * Minimum significant tokens required on BOTH sides before the lexical
 * comparison is trusted. Jaccard on very short strings is meaningless: a
 * two-token label like "Concept number 0" and "Concept number 1" differ by a
 * single token, which is a 0.5 score on noise rather than a real signal.
 * Facts shorter than this are left to the vector path alone.
 */
const MIN_LEXICAL_TOKENS = 4;

/** Stop words stripped before lexical comparison (boilerplate-heavy prose). */
const LEXICAL_STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "user", "key",
  "facts", "preferences", "profile", "assistant", "building", "current",
  "about", "into", "their", "they", "have", "has", "are", "was", "were",
]);

/**
 * Normalize to a comparable token set: lowercase, punctuation-free,
 * stop-word-free. Single-character tokens are retained — numerals carry real
 * meaning in facts ("32-band preset", "v4.5") and dropping them would make
 * otherwise-distinct rows look identical.
 */
function lexicalTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[#*_`>]/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0 && !LEXICAL_STOP_WORDS.has(t))
  );
}

/**
 * Jaccard similarity of two token sets. Returns 0 when either side is too
 * short for the comparison to carry signal (see `MIN_LEXICAL_TOKENS`).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size < MIN_LEXICAL_TOKENS || b.size < MIN_LEXICAL_TOKENS) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function safeParseJsonArray(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.debug(`[semantic-memory] Error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

const MUTUALLY_EXCLUSIVE_GROUPS: string[][] = [
  ["tabs", "spaces", "tab", "space"],
  ["dark", "light"],
  ["true", "false"],
  ["yes", "no"],
  ["enable", "disable", "enabled", "disabled"],
  ["on", "off"],
  ["always", "never"],
  ["allow", "deny", "allowed", "denied"],
  ["npm", "pnpm", "yarn", "bun"],
  ["vim", "neovim", "emacs", "vscode"],
  ["drizzle", "prisma", "typeorm"],
];

const REVERSAL_PATTERNS = [
  /\bno longer\b/i,
  /\bnot anymore\b/i,
  /\bstopped using\b/i,
  /\bswitched from\b/i,
  /\bswitched to\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bdon'?t use\b/i,
  /\bdo not use\b/i,
  /\bnever use\b/i,
];

const PREFERENCE_WORDS = new Set([
  "prefer", "prefers", "preference", "preferences",
  "like", "likes", "dislike", "dislikes",
  "want", "wants",
  "use", "uses",
  "always", "never",
  "should", "must",
]);

const GENERIC_META_TAGS = new Set([
  "preference",
  "user_preference",
  "consolidated_memory",
  "fact",
]);

function parseMetadataObject(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      console.debug(`[semantic-memory] Error: ${err instanceof Error ? err.message : String(err)}`);
      return {};
    }
  }
  return {};
}

function extractTagsSet(tags: unknown): Set<string> {
  const result = new Set<string>();
  const tagList = Array.isArray(tags)
    ? tags
    : safeParseJsonArray(typeof tags === "string" ? tags : null) ?? [];
  for (const t of tagList) {
    if (typeof t === "string" && t.trim().length > 0) {
      result.add(t.trim().toLowerCase());
    }
  }
  return result;
}

function hasSharedCategory(
  tagsA: Set<string>,
  metaCategoryA: string | undefined,
  tagsB: Set<string>,
  metaCategoryB: string | undefined
): boolean {
  // If metadata.category is present on both, enforce that they match
  if (metaCategoryA && metaCategoryB && metaCategoryA !== metaCategoryB) {
    return false;
  }

  // If either has no tags and no metadata category, uncategorized remain independent
  if (
    (tagsA.size === 0 && !metaCategoryA) ||
    (tagsB.size === 0 && !metaCategoryB)
  ) {
    return false;
  }

  const domainA = new Set([...tagsA].filter((t) => !GENERIC_META_TAGS.has(t)));
  const domainB = new Set([...tagsB].filter((t) => !GENERIC_META_TAGS.has(t)));

  // If both have specific domain tags, they must overlap
  if (domainA.size > 0 && domainB.size > 0) {
    for (const tag of domainA) {
      if (domainB.has(tag)) return true;
    }
    return false;
  }

  // If one has domain tags and the other only has generic tags, they are not in the same domain
  if (domainA.size > 0 || domainB.size > 0) {
    return false;
  }

  // Both have only generic tags or metadata.category: check for shared generic tags or matching category
  if (metaCategoryA && metaCategoryB && metaCategoryA === metaCategoryB) {
    return true;
  }

  for (const tag of tagsA) {
    if (tagsB.has(tag)) return true;
  }

  return false;
}

function hasContradiction(priorContent: string, incomingContent: string): boolean {
  const priorTokens = lexicalTokens(priorContent);
  const incomingTokens = lexicalTokens(incomingContent);

  const sharedTokens = new Set<string>();
  for (const t of priorTokens) {
    if (incomingTokens.has(t)) sharedTokens.add(t);
  }

  const priorOnly = new Set<string>();
  for (const t of priorTokens) {
    if (!incomingTokens.has(t)) priorOnly.add(t);
  }

  const incomingOnly = new Set<string>();
  for (const t of incomingTokens) {
    if (!priorTokens.has(t)) incomingOnly.add(t);
  }

  // 1. Direct negation / reversal patterns in incoming content
  for (const pattern of REVERSAL_PATTERNS) {
    if (pattern.test(incomingContent)) {
      const sharedSubjectTokens = [...sharedTokens].filter((t) => !PREFERENCE_WORDS.has(t));
      if (sharedSubjectTokens.length > 0) return true;
    }
  }

  // 2. Explicit opposing pairs / mutually exclusive groups
  // ponytail: token-based slot opposition; upgrade to semantic dependency parse if phrasing varies widely.
  for (const group of MUTUALLY_EXCLUSIVE_GROUPS) {
    let priorMatch: string | null = null;
    let incomingMatch: string | null = null;

    for (const item of group) {
      if (priorOnly.has(item)) priorMatch = item;
      if (incomingOnly.has(item)) incomingMatch = item;
    }

    if (priorMatch && incomingMatch && priorMatch !== incomingMatch) {
      return true;
    }
  }

  return false;
}

/**
 * Fast dedup via the sqlite-vec index: one KNN query instead of a full
 * table scan. Falls back to the JS scan path when the index is unavailable.
 *
 * Returns the best duplicate (similarity ≥ NEAR_DUPLICATE_THRESHOLD) or null.
 */
function findNearDuplicateVec(
  embedding: Float32Array,
  dim: number,
  embeddingModel: string,
  db: AppDatabase,
  sqlite: Database.Database
): { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null {
  if (!isVectorIndexAvailable(sqlite)) return null;
  if (!syncVectorIndex(sqlite, "semantic", dim, embeddingModel)) return null;

  // The vec table is namespaced by embedding model, so the duplicate probe only
  // compares against rows embedded under the same model — cross-model vectors
  // are dimensionally incompatible and would produce meaningless distances.
  const vecTable = vectorTableFor("semantic", embeddingModel);
  const queryBuffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  const hit = sqlite
    .prepare(
      `SELECT s.id, s.importance, s.tags, s.sources
         FROM ${vecTable} v
         JOIN semantic_memories s ON s.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = 1 AND v.distance <= ?
        ORDER BY v.distance`
    )
    .get(queryBuffer, NEAR_DUPLICATE_DISTANCE) as
    | { id: string; importance: number; tags: string; sources: string }
    | undefined;

  if (!hit) return null;

  return {
    id: hit.id,
    importance: hit.importance,
    tags: safeParseJsonArray(hit.tags),
    sources: safeParseJsonArray(hit.sources),
  };
}

function findNearDuplicate(
  embedding: Float32Array,
  embeddingModel: string,
  db: AppDatabase,
  sqlite: Database.Database
): { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null {
  const dim = embedding.length;

  // Fast path: sqlite-vec index (O(log N)).
  const vecHit = findNearDuplicateVec(embedding, dim, embeddingModel, db, sqlite);
  if (vecHit !== null) return vecHit;

  // Slow path: JS full-table cosine scan (O(N)).
  // Used when sqlite-vec is not loaded on this connection or the index is
  // being rebuilt (e.g. immediately after rebuildEmbeddingIndex nulls all
  // vectors). At personal-assistant scale this is still sub-millisecond.
  const rows = db
    .select({
      id: semanticMemories.id,
      importance: semanticMemories.importance,
      tags: semanticMemories.tags,
      sources: semanticMemories.sources,
      embedding: semanticMemories.embedding,
    })
    .from(semanticMemories)
    .all();

  let best: { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null = null;
  let bestSimilarity = NEAR_DUPLICATE_THRESHOLD;

  for (const row of rows) {
    if (!row.embedding) continue;
    const similarity = cosineSimilarity(embedding, bufferToVector(row.embedding as Buffer));
    if (similarity >= bestSimilarity) {
      bestSimilarity = similarity;
      best = row;
    }
  }

  return best;
}

/**
 * Lexical duplicate probe for rows that cannot be compared by vector — either
 * the incoming fact has no embedding (endpoint down at write time) or the
 * candidate row has none (queued for backfill). Without this path those rows
 * bypass deduplication entirely and accumulate without bound.
 *
 * Compares normalized token sets by Jaccard similarity against every stored
 * row. At personal-assistant scale (hundreds of rows) this is sub-millisecond.
 */
function findLexicalDuplicate(
  content: string,
  db: AppDatabase
): { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null {
  const incoming = lexicalTokens(content);
  if (incoming.size === 0) return null;

  const rows = db
    .select({
      id: semanticMemories.id,
      content: semanticMemories.content,
      importance: semanticMemories.importance,
      tags: semanticMemories.tags,
      sources: semanticMemories.sources,
    })
    .from(semanticMemories)
    .all();

  let best: { id: string; importance: number; tags: string[] | null; sources: string[] | null } | null = null;
  let bestScore = LEXICAL_DUPLICATE_THRESHOLD;

  for (const row of rows) {
    const score = jaccardSimilarity(incoming, lexicalTokens(row.content));
    if (score >= bestScore) {
      bestScore = score;
      best = {
        id: row.id,
        importance: row.importance,
        tags: row.tags,
        sources: row.sources,
      };
    }
  }

  return best;
}

export async function addSemanticMemory(
  input: SemanticMemoryInput,
  db: AppDatabase = defaultDb,
  sqlite?: Database.Database
): Promise<string> {
  // Resolve underlying better-sqlite3 instance: prefer explicit argument,
  // then drizzle $client on the provided db instance, then defaultSqlite.
  const resolvedSqlite =
    sqlite ??
    (db as unknown as { $client?: Database.Database }).$client ??
    defaultSqlite;

  // Wrap near-duplicate check and insert/update in an atomic transaction
  // to prevent race conditions during concurrent background ingestion / reflections.
  return db.transaction((tx) => {
    // Access the underlying better-sqlite3 connection from the Drizzle
    // transaction with safe navigation, falling back to resolvedSqlite.
    const rawSqlite: Database.Database =
      (tx as unknown as { session?: { client?: Database.Database } }).session?.client ??
      resolvedSqlite;

    // Layer 1 — vector probe. Available whenever the incoming fact was
    // embedded; catches semantic paraphrases that share no surface tokens.
    // Scoped to the incoming fact's embedding model: vectors from different
    // models live in different spaces and are never comparable.
    let duplicate = input.embedding
      ? findNearDuplicate(
          input.embedding,
          input.embeddingModel ?? "unknown",
          tx as unknown as AppDatabase,
          rawSqlite
        )
      : null;

    // Layer 2 — lexical probe. Runs when the vector path found nothing,
    // including the case where either row lacks an embedding. Catches
    // near-identical text that a missing vector would otherwise let through.
    if (!duplicate) {
      duplicate = findLexicalDuplicate(input.content, tx as unknown as AppDatabase);
    }

    if (duplicate) {
      const mergedTags = Array.from(
        new Set([...(duplicate.tags ?? []), ...(input.tags ?? [])])
      );
      const mergedSources = Array.from(
        new Set([...(duplicate.sources ?? []), ...(input.sources ?? [])])
      );
      tx
        .update(semanticMemories)
        .set({
          importance: Math.max(duplicate.importance, input.importance ?? 0.5),
          tags: mergedTags,
          sources: mergedSources,
          embeddingModel: input.embeddingModel ?? null,
          updatedAt: new Date(),
        })
        .where(eq(semanticMemories.id, duplicate.id))
        .run();
      return duplicate.id;
    }

    const id = `sem_${nanoid(12)}`;

    // Calibrated passive contradiction detection:
    // Only runs when incoming fact is embedded and carries category/domain tags.
    // Detects conflicting prior memories in the same category within [0.78, 0.90) similarity
    // and atomically supersedes them.
    const incomingCategory =
      typeof input.metadata?.category === "string" && input.metadata.category.trim().length > 0
        ? input.metadata.category.trim().toLowerCase()
        : undefined;
    const incomingTags = extractTagsSet(input.tags);

    if (input.embedding && (incomingTags.size > 0 || incomingCategory)) {
      const conditions = [
        isNotNull(semanticMemories.embedding),
        or(isNull(semanticMemories.metadata), notLike(semanticMemories.metadata, '%"superseded":true%')),
      ];
      if (input.embeddingModel) {
        conditions.push(eq(semanticMemories.embeddingModel, input.embeddingModel));
      }

      const priorRows = tx
        .select({
          id: semanticMemories.id,
          content: semanticMemories.content,
          importance: semanticMemories.importance,
          tags: semanticMemories.tags,
          metadata: semanticMemories.metadata,
          embedding: semanticMemories.embedding,
        })
        .from(semanticMemories)
        .where(and(...conditions))
        .all();

      for (const prior of priorRows) {
        if (!prior.embedding) continue;
        const priorMeta = parseMetadataObject(prior.metadata);
        if (priorMeta.superseded) continue;

        const priorCategory =
          typeof priorMeta.category === "string" && priorMeta.category.trim().length > 0
            ? priorMeta.category.trim().toLowerCase()
            : undefined;
        const priorTags = extractTagsSet(prior.tags);

        if (!hasSharedCategory(incomingTags, incomingCategory, priorTags, priorCategory)) continue;

        const similarity = cosineSimilarity(
          input.embedding,
          bufferToVector(prior.embedding as Buffer)
        );

        if (
          similarity >= CONTRADICTION_SIMILARITY_MIN &&
          similarity < NEAR_DUPLICATE_THRESHOLD &&
          hasContradiction(prior.content, input.content)
        ) {
          tx.update(semanticMemories)
            .set({
              importance: 0.1,
              metadata: {
                ...priorMeta,
                superseded: true,
                supersededBy: id,
                supersededAt: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .where(eq(semanticMemories.id, prior.id))
            .run();

          tx.insert(memoryRelations)
            .values({
              id: `rel_${nanoid(12)}`,
              fromMemoryId: prior.id,
              fromMemoryType: "semantic",
              toMemoryId: id,
              toMemoryType: "semantic",
              relationType: "superseded_by",
              strength: 0.95,
            })
            .run();
        }
      }
    }

    tx.insert(semanticMemories).values({
      id,
      content: input.content,
      embedding: input.embedding ? vectorToBuffer(input.embedding) : null,
      embeddingModel: input.embeddingModel ?? null,
      importance: input.importance ?? 0.5,
      tags: input.tags ?? [],
      sources: input.sources ?? [],
      metadata: input.metadata ?? {},
    }).run();

    return id;
  });
}

export async function linkMemories(
  input: MemoryRelationInput,
  db: AppDatabase = defaultDb
): Promise<string> {
  const id = `rel_${nanoid(12)}`;

  await db.insert(memoryRelations).values({
    id,
    fromMemoryId: input.fromMemoryId,
    fromMemoryType: input.fromMemoryType,
    toMemoryId: input.toMemoryId,
    toMemoryType: input.toMemoryType,
    relationType: input.relationType,
    strength: input.strength ?? 0.5,
  });

  return id;
}
