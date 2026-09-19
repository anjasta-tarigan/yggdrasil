import { z } from "zod";
import { generateText, Output } from "ai";
import { getDefaultModel } from "@/lib/ai/provider";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db as defaultDb, type AppDatabase } from "@/db";
import { memoryRelations, semanticMemories } from "@/db/schema";
import { addSemanticMemory } from "./semantic-memory";
import { detectLanguage } from "@/lib/text/language";
import {
  bufferToVector,
  cosineSimilarity,
  generateEmbedding,
  resolveEmbeddingModel,
} from "./embeddings";

export interface ReflectionPayload {
  sessionId?: string;
  userPrompt: string;
  assistantResponse: string;
}

export interface ExtractedFact {
  content: string;
  category?: string;
  importance?: number;
  tags?: string[];
}

export interface ProceduralRule {
  situation: string;
  mistake: string;
  correction: string;
  tags?: string[];
}

export interface ReflectionResult {
  newFacts: ExtractedFact[];
  correctionDetected: boolean;
  proceduralRule?: ProceduralRule | null;
}

export const reflectionSchema = z.object({
  newFacts: z
    .array(
      z.object({
        content: z.string(),
        category: z.string().optional(),
        importance: z.number().min(0).max(1).optional().default(0.7),
        tags: z.array(z.string()).optional().default([]),
      })
    )
    .optional()
    .default([]),
  correctionDetected: z.boolean().optional().default(false),
  proceduralRule: z
    .object({
      situation: z.string(),
      mistake: z.string(),
      correction: z.string(),
      tags: z.array(z.string()).optional().default(["procedural_rule"]),
    })
    .nullable()
    .optional(),
});

const CORRECTION_PATTERNS = [
  /\bno\b/i,
  /\bwrong\b/i,
  /\bactually\b/i,
  /\binstead\b/i,
  /\bnot that\b/i,
  /\bdon'?t\b/i,
  /\bstop\b/i,
  /\bmistake\b/i,
  /\berror\b/i,
  /\bincorrect\b/i,
  /\bfix this\b/i,
  /\byou forgot\b/i,
];

const PREFERENCE_PATTERNS = [
  /\bi prefer\b/i,
  /\balways use\b/i,
  /\bnever use\b/i,
  /\bmy project is\b/i,
  /\bi want\b/i,
  /\bi like\b/i,
  /\bfrom now on\b/i,
  /\bremember that\b/i,
  /\bkeep in mind\b/i,
];

/**
 * Heuristic cost filter: returns true if the turn likely contains
 * user corrections, preferences, or reaches a milestone turn count.
 */
export function shouldReflectOnTurn(userPrompt: string, turnIndex: number): boolean {
  if (turnIndex > 0 && turnIndex % 5 === 0) {
    return true;
  }

  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(userPrompt)) {
      return true;
    }
  }

  for (const pattern of PREFERENCE_PATTERNS) {
    if (pattern.test(userPrompt)) {
      return true;
    }
  }

  return false;
}

/**
 * Leniently extracts and validates a reflection JSON object from free-form
 * model text (tolerates conversational preambles like "Here is the JSON:").
 * Exported for tests; used as the fallback path of `defaultTurnReflector`.
 */
export function parseReflectionText(text: string): ReflectionResult {
  const cleaned = text.trim();

  // Try markdown json code block first
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      const validated = reflectionSchema.parse(parsed);
      return {
        newFacts: validated.newFacts,
        correctionDetected: validated.correctionDetected,
        proceduralRule: validated.proceduralRule ?? null,
      };
    } catch (err) {
      if (err instanceof z.ZodError) throw err;
      // Fall through to balanced brace extraction
    }
  }

  // Find the first balanced JSON object by scanning brace depth from the first {
  const firstBrace = cleaned.indexOf("{");
  if (firstBrace === -1) {
    throw new Error(`No JSON object found in reflection response: ${cleaned}`);
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let endBrace = -1;

  for (let i = firstBrace; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          endBrace = i;
          break;
        }
      }
    }
  }

  if (endBrace === -1) {
    throw new Error(`No JSON object found in reflection response: ${cleaned}`);
  }

  const candidate = cleaned.slice(firstBrace, endBrace + 1);
  const parsed = JSON.parse(candidate);
  const validated = reflectionSchema.parse(parsed);
  return {
    newFacts: validated.newFacts,
    correctionDetected: validated.correctionDetected,
    proceduralRule: validated.proceduralRule ?? null,
  };
}

/**
 * Default LLM-based reflection parser.
 *
 * Primary path: AI SDK v7 structured output (`generateText` + `Output.object`).
 * The SDK constrains the response to `reflectionSchema` and validates it,
 * which replaces the brittle manual JSON extraction that failed whenever the
 * model wrapped its answer in prose or markdown fences.
 *
 * Fallback path: some self-hosted / openai-compatible endpoints do not
 * implement constrained decoding. When structured output generation fails,
 * one free-text attempt with lenient JSON extraction keeps the pipeline
 * alive. If both paths fail the error propagates so the queue runner can
 * retry with backoff.
 */
export async function defaultTurnReflector(
  payload: ReflectionPayload
): Promise<ReflectionResult> {
  const prompt = `You are a cognitive memory reflection agent. Analyze the following conversation turn between a user and an assistant:

User Prompt:
"""
${payload.userPrompt}
"""

Assistant Response:
"""
${payload.assistantResponse}
"""

Instructions:
1. Extract any new durable facts, user preferences, or project details that should be remembered in long-term semantic memory.
2. Determine if the user's prompt was a correction, critique, or identification of a mistake in the assistant's previous approach.
3. If a correction or mistake was identified, formulate a concise procedural rule to avoid making that mistake in the future (situation, mistake to avoid, correct approach).
4. Return the result as a single JSON object with this shape:
{
  "newFacts": [
    { "content": "string", "category": "user_preference" | "project_fact" | "domain_knowledge", "importance": number between 0 and 1, "tags": ["tag1"] }
  ],
  "correctionDetected": boolean,
  "proceduralRule": {
    "situation": "string describing context or domain",
    "mistake": "string describing what was wrong or should be avoided",
    "correction": "string describing the correct pattern or behavior",
    "tags": ["tag1", "procedural_rule"]
  } | null
}
Return only the JSON object, without markdown fences.`;

  const system =
    "You are a structured reflection engine for an AI assistant. You output valid JSON only.";

  try {
    const { output } = await generateText({
      model: await getDefaultModel(),
      prompt,
      system,
      output: Output.object({
        schema: reflectionSchema,
        name: "turn_reflection",
        description:
          "Extracted durable facts, correction detection and procedural mistake-prevention rule for one conversation turn",
      }),
    });

    return {
      newFacts: output.newFacts,
      correctionDetected: output.correctionDetected,
      proceduralRule: output.proceduralRule ?? null,
    };
  } catch (structuredErr) {
    console.warn(
      "[reflection] Structured output generation failed; retrying with free-text JSON extraction:",
      structuredErr
    );
  }

  const { text, reasoningText } = await generateText({
    model: await getDefaultModel(),
    prompt,
    system,
  });

  try {
    const candidate = text && text.trim().length > 0 ? text : (reasoningText ?? "");
    return parseReflectionText(candidate);
  } catch (err) {
    console.error("[reflection] defaultTurnReflector failed:", err);
    throw err; // Propagate so the queue runner can retry with backoff
  }
}

/**
 * Executes post-turn verbal reflection and persists extracted facts and
 * procedural rules into semantic_memories with embeddings.
 */
export async function executeTurnReflection(
  payload: ReflectionPayload,
  db: AppDatabase = defaultDb,
  reflector: (payload: ReflectionPayload) => Promise<ReflectionResult> = defaultTurnReflector
): Promise<ReflectionResult> {
  const result = await reflector(payload);

  // Store new facts in semantic memory
  for (const fact of result.newFacts) {
    if (!fact.content || fact.content.trim().length === 0) continue;
    const embedding = await generateEmbedding(fact.content);
    const embeddingModel = await resolveEmbeddingModel();
    const tags = fact.tags && fact.tags.length > 0 ? fact.tags : (fact.category ? [fact.category] : []);
    const newMemoryId = await addSemanticMemory(
      {
        content: fact.content,
        importance: fact.importance ?? 0.7,
        tags,
        sources: payload.sessionId ? [payload.sessionId] : [],
        metadata: {
          category: fact.category || "reflection_fact",
          extractedFrom: "verbal_reflection",
          language: detectLanguage(fact.content),
        },
        embedding,
        embeddingModel,
      },
      db
    );

    // Contradiction resolution: when user correction is detected, find and supersede
    // conflicting prior memories so outdated facts fade from context
    if (result.correctionDetected) {
      try {
        const priorMemories = await db
          .select({
            id: semanticMemories.id,
            content: semanticMemories.content,
            embedding: semanticMemories.embedding,
            metadata: semanticMemories.metadata,
          })
          .from(semanticMemories)
          .where(ne(semanticMemories.id, newMemoryId));

        const newWords = new Set(
          fact.content
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length > 3)
        );

        for (const prior of priorMemories) {
          let isConflict = false;
          if (embedding && prior.embedding) {
            const priorVec = bufferToVector(prior.embedding as Buffer);
            const sim = cosineSimilarity(embedding, priorVec);
            if (sim > 0.65) isConflict = true;
          } else {
            // Lexical overlap fallback for memories without pre-computed embeddings
            const priorWords = prior.content
              .toLowerCase()
              .split(/\W+/)
              .filter((w) => w.length > 3);
            const overlap = priorWords.filter((w) => newWords.has(w)).length;
            if (overlap >= 2) isConflict = true;
          }

          // Topically related prior memory that is being corrected
          if (isConflict) {
            db.transaction((tx) => {
              tx.insert(memoryRelations)
                .values({
                  id: `rel_${nanoid(12)}`,
                  fromMemoryId: prior.id,
                  fromMemoryType: "semantic",
                  toMemoryId: newMemoryId,
                  toMemoryType: "semantic",
                  relationType: "superseded_by",
                  strength: 0.95,
                })
                .run();

              const currentMeta = (prior.metadata ?? {}) as Record<string, unknown>;
              tx.update(semanticMemories)
                .set({
                  importance: 0.1,
                  metadata: {
                    ...currentMeta,
                    superseded: true,
                    supersededBy: newMemoryId,
                    supersededAt: new Date().toISOString(),
                  },
                })
                .where(eq(semanticMemories.id, prior.id))
                .run();
            });
          }
        }
      } catch (err) {
        console.debug(`[reflection] Error: ${err instanceof Error ? err.message : String(err)}`);
        // Non-fatal if contradiction resolution encounters an error
      }
    }
  }

  // Store procedural mistake-prevention rule in semantic memory
  if (result.proceduralRule) {
    const { situation, mistake, correction, tags } = result.proceduralRule;
    const ruleContent = `[PROCEDURAL RULE - MISTAKE TO AVOID]\nSituation: ${situation}\nMistake to avoid: ${mistake}\nCorrect pattern: ${correction}`;
    const embedding = await generateEmbedding(ruleContent);
    const embeddingModel = await resolveEmbeddingModel();

    const mergedTags = Array.from(
      new Set([...(tags || []), "procedural_rule", "mistake_prevention"])
    );

    // Rule quality control: downgrade existing rules that covered the
    // same situation but prescribed a different correction. This prevents
    // contradictory rules from accumulating in memory.
    await downgradeConflictingRules(situation, correction, db);

    await addSemanticMemory(
      {
        content: ruleContent,
        importance: 0.95, // High default importance for learned rules
        tags: mergedTags,
        sources: payload.sessionId ? [payload.sessionId] : [],
        metadata: {
          situation,
          mistake,
          correction,
          extractedFrom: "verbal_reflection",
        },
        embedding,
        embeddingModel,
      },
      db
    );
  }

  return result;
}

// ── Semantic mistake detection & rule quality control ────────────────────

/**
 * Seed phrases that capture the *intent* of a correction or mistake
 * acknowledgement, independent of exact wording. These are embedded once
 * and cached; new user messages are compared via cosine similarity rather
 * than brittle keyword regexes.
 */
const CORRECTION_SEED_PHRASES = [
  "no that is wrong",
  "actually that is not correct",
  "I made a mistake earlier",
  "you forgot to",
  "stop doing that instead",
  "that is incorrect please fix",
  "I was wrong about",
  "please disregard what I said before",
  "the correct approach is",
  "I prefer a different way",
  "from now on do it this way",
  "remember this preference",
  "always use this instead",
  "never use that approach again",
];

/** Cached seed embeddings, populated lazily on first use. */
let cachedCorrectionVectors: Float32Array[] | null = null;

/**
 * Semantic mistake / correction detector. Replaces the pure-regex
 * `CORRECTION_PATTERNS` approach: instead of matching keywords, it
 * embeds the user message and compares it against a set of correction
 * seed phrases. This catches corrections expressed in different words
 * (e.g. "that's not right" vs "you forgot to handle that case").
 *
 * Falls back to the regex patterns when the embedding endpoint is
 * unavailable so detection never breaks entirely.
 *
 * @returns similarity score (0-1); values above 0.65 indicate a correction.
 */
export async function detectMistakeSemantic(
  userPrompt: string,
  options: { db?: AppDatabase } = {}
): Promise<number> {
  if (!userPrompt || userPrompt.trim().length < 10) return 0;

  // Fast regex pre-filter: if no regex matches, the message is very
  // unlikely to be a correction, so skip the embedding call.
  let regexMatched = false;
  for (const pattern of CORRECTION_PATTERNS) {
    if (pattern.test(userPrompt)) {
      regexMatched = true;
      break;
    }
  }
  for (const pattern of PREFERENCE_PATTERNS) {
    if (pattern.test(userPrompt)) {
      regexMatched = true;
      break;
    }
  }
  if (!regexMatched) return 0;

  // Lazy-load seed phrase embeddings.
  if (cachedCorrectionVectors === null) {
    const vectors: Float32Array[] = [];
    for (const phrase of CORRECTION_SEED_PHRASES) {
      const vec = await generateEmbedding(phrase);
      if (vec) vectors.push(vec);
    }
    cachedCorrectionVectors = vectors;
  }

  if (cachedCorrectionVectors.length === 0) {
    // Endpoint unavailable — fall back to regex match = weak signal.
    return 0.5;
  }

  const userVector = await generateEmbedding(userPrompt.slice(0, 500));
  if (!userVector) {
    return 0.5; // regex matched but embedding failed — weak signal
  }

  let maxSim = 0;
  for (const seedVec of cachedCorrectionVectors) {
    if (seedVec.length !== userVector.length) continue;
    const sim = cosineSimilarity(userVector, seedVec);
    if (sim > maxSim) maxSim = sim;
  }

  return maxSim;
}

/** Confidence threshold above which a message is treated as a correction. */
export const MISTAKE_CONFIDENCE_THRESHOLD = 0.65;

/**
 * Rule quality control: when a new procedural rule is detected, check
 * whether an existing rule covers the *same situation* but prescribes a
 * *different correction*. If so, the old rule is downgraded (importance
 * halved, "superseded" tag added) instead of letting conflicting rules
 * accumulate in memory.
 *
 * This prevents the memory system from becoming a graveyard of
 * contradictory rules where each correction spawns a new entry that
 * overrides the previous one without cleaning it up.
 */
export async function downgradeConflictingRules(
  newSituation: string,
  newCorrection: string,
  db: AppDatabase = defaultDb
): Promise<{ downgraded: number; downgradedIds: string[] }> {
  const situationVector = await generateEmbedding(newSituation);
  if (!situationVector) {
    return { downgraded: 0, downgradedIds: [] };
  }

  // Fetch existing procedural rules.
  const existing = db
    .select({
      id: semanticMemories.id,
      content: semanticMemories.content,
      importance: semanticMemories.importance,
      embedding: semanticMemories.embedding,
      tags: semanticMemories.tags,
    })
    .from(semanticMemories)
    .where(sql`${semanticMemories.tags} LIKE '%"procedural_rule"%'`)
    .all();

  const downgradedIds: string[] = [];
  for (const rule of existing) {
    if (!rule.embedding) continue;
    const ruleVec = bufferToVector(rule.embedding as Buffer);
    const similar = cosineSimilarity(
      situationVector,
      ruleVec
    );

    // High similarity in the situation but a different correction →
    // this is likely a superseded rule, not a duplicate.
    if (similar > 0.85) {
      // Check if the existing rule already mentions the old correction.
      // If the new correction is different, downgrade the old rule.
      if (rule.content && !rule.content.includes(newCorrection)) {
        const newImportance = Math.max(0.1, (rule.importance ?? 0.95) * 0.5);
        const existingTags = rule.tags ?? [];
        const newTags = Array.from(
          new Set([...existingTags, "superseded"])
        );
        db
          .update(semanticMemories)
          .set({
            importance: newImportance,
            tags: newTags,
            updatedAt: new Date(),
          })
          .where(eq(semanticMemories.id, rule.id))
          .run();
        downgradedIds.push(rule.id);
      }
    }
  }

  return {
    downgraded: downgradedIds.length,
    downgradedIds,
  };
}

/**
 * Periodic rule quality review: downgrades procedural rules that haven't
 * been accessed in a long time (Ebbinghaus-style). Rules that are never
 * recalled are likely irrelevant and should make room for new ones.
 *
 * This is intended to run as part of the decay sweep.
 */
export async function reviewProceduralRules(
  db: AppDatabase = defaultDb,
  staleDays: number = 30
): Promise<{ reviewed: number; downgraded: number }> {
  const cutoff = Math.floor(Date.now() / 1000 - staleDays * 86400);

  const staleRules = db
    .select({
      id: semanticMemories.id,
      importance: semanticMemories.importance,
    })
    .from(semanticMemories)
    .where(
      and(
        sql`${semanticMemories.tags} LIKE '%"procedural_rule"%'`,
        or(
          isNull(semanticMemories.lastAccessedAt),
          // `lastAccessedAt` is an integer (mode: "timestamp", unix seconds),
          // so compare it directly. Wrapping it in strftime('%s', <int>) yields
          // NULL — SQLite date functions expect a string — which silently made
          // this branch never match and kept accessed rules from ever expiring.
          sql`${semanticMemories.lastAccessedAt} < ${cutoff}`
        )
      )
    )
    .orderBy(desc(semanticMemories.createdAt))
    .limit(100)
    .all();

  let downgraded = 0;
  for (const rule of staleRules) {
    const newImportance = Math.max(0.1, (rule.importance ?? 0.95) * 0.5);
    db
      .update(semanticMemories)
      .set({
        importance: newImportance,
        updatedAt: new Date(),
      })
      .where(eq(semanticMemories.id, rule.id))
      .run();
    downgraded++;
  }

  return {
    reviewed: staleRules.length,
    downgraded,
  };
}
