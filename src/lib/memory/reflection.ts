import { z } from "zod";
import { generateText, Output } from "ai";
import { defaultModel } from "@/lib/ai/provider";
import { db as defaultDb, type AppDatabase } from "@/db";
import { addSemanticMemory } from "./semantic-memory";
import { generateEmbedding } from "./embeddings";

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
      model: defaultModel,
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

  const { text } = await generateText({
    model: defaultModel,
    prompt,
    system,
  });

  try {
    return parseReflectionText(text);
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
    const tags = fact.tags && fact.tags.length > 0 ? fact.tags : (fact.category ? [fact.category] : []);
    await addSemanticMemory(
      {
        content: fact.content,
        importance: fact.importance ?? 0.7,
        tags,
        sources: payload.sessionId ? [payload.sessionId] : [],
        metadata: {
          category: fact.category || "reflection_fact",
          extractedFrom: "verbal_reflection",
        },
        embedding,
      },
      db
    );
  }

  // Store procedural mistake-prevention rule in semantic memory
  if (result.proceduralRule) {
    const { situation, mistake, correction, tags } = result.proceduralRule;
    const ruleContent = `[PROCEDURAL RULE - MISTAKE TO AVOID]\nSituation: ${situation}\nMistake to avoid: ${mistake}\nCorrect pattern: ${correction}`;
    const embedding = await generateEmbedding(ruleContent);

    const mergedTags = Array.from(
      new Set([...(tags || []), "procedural_rule", "mistake_prevention"])
    );

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
      },
      db
    );
  }

  return result;
}
