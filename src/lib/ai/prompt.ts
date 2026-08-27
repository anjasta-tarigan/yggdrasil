import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { semanticMemories } from "@/db/schema";
import { desc, like } from "drizzle-orm";
import { getActiveWorkingMemories } from "@/lib/memory/working-memory";
import { hybridMemorySearch } from "@/lib/memory/search";
import {
  buildSkillsCatalogBlock,
  truncateToTokenBudget,
} from "@/lib/skills/catalog";

export interface PromptBudgetConfig {
  baseTokens?: number;
  skillsTokens?: number;
  proceduralTokens?: number;
  preferenceTokens?: number;
  contextTokens?: number;
}

export interface PromptSynthesisOptions {
  userQuery?: string;
  db?: AppDatabase;
  sqlite?: Database.Database;
  budgets?: PromptBudgetConfig;
}

const DEFAULT_BUDGETS: Required<PromptBudgetConfig> = {
  baseTokens: 500,
  skillsTokens: 800,
  proceduralTokens: 800,
  preferenceTokens: 500,
  contextTokens: 1200,
};

/**
 * Synthesizes the dynamic system prompt with strict token budgets:
 * Layer 1: Base behavioral invariants (~500 tokens)
 * Layer 1b: Installed skills catalog — progressive disclosure step 1 (max 800 tokens)
 * Layer 2: Learned procedural mistake-prevention rules matching user query (max 800 tokens)
 * Layer 3: Semantic user profile and preferences (max 500 tokens)
 * Layer 4: Active unexpired working memory and relevant episodic context (max 1200 tokens)
 */
export async function synthesizeSystemPrompt(
  options: PromptSynthesisOptions = {}
): Promise<string> {
  const db = options.db ?? defaultDb;
  const sqlite = options.sqlite ?? defaultSqlite;
  const userQuery = options.userQuery?.trim() ?? "";
  const budgets: Required<PromptBudgetConfig> = {
    ...DEFAULT_BUDGETS,
    ...options.budgets,
  };

  // Layer 1: Base behavioral rules (~500 tokens)
  const baseRawPrompt = `You are Yggdrasil, an intelligent and proactive personal AI assistant. You are concise, direct, and capable.

# Core Invariants & Tool Usage Principles:

1. Autonomous Web Research (Proactive Search):
   - You have 'web_search' and 'fetch_page' tools.
   - Proactively execute 'web_search' as your first step whenever a question involves current events, recent software/library versions, API syntax, live data, documentation, or facts outside your training cutoff.
   - Do NOT wait for the user to say "search the web" or ask permission to search. Take the initiative.
   - When referencing search findings, cite the URLs you used.

2. Deliverables & Artifact Creation ('create_artifact'):
   - You have the 'create_artifact' tool, which opens a dedicated preview side-panel for the user.
   - Whenever the user asks to create, build, generate, or sample an artifact, code file, script, HTML/JS/CSS interactive app/demo, SVG graphic, React component, or standalone markdown report, you MUST call 'create_artifact'.
   - STRICT PROHIBITION: NEVER output complete code files or interactive demos as fenced markdown code blocks in your text reply. Always place them inside 'create_artifact'.
   - In your chat text response, provide only a brief 1-2 sentence overview/explanation; the full content must live inside the artifact tool call.
   - Only use inline code blocks for tiny snippets (1-5 lines) or inline command examples.

3. Task Management ('manage_tasks'):
   - For multi-step planning or complex requests, invoke 'manage_tasks' with all items marked pending, and update it as progress occurs.`;

  const [baseBehavioralPrompt] = truncateToTokenBudget([baseRawPrompt], budgets.baseTokens);

  // Layer 1b: installed skills catalog (name + description per enabled
  // skill; full bodies load on demand via the use_skill tool).
  let skillsCatalogBlock = "";
  try {
    skillsCatalogBlock = await buildSkillsCatalogBlock({
      db,
      budgetTokens: budgets.skillsTokens,
    });
  } catch (err) {
    console.warn("[prompt] Failed to build skills catalog block:", err);
  }

  // Single hybrid search retrieval pass across memory tiers (saves duplicate embeddings and FTS queries)
  let searchResults: Awaited<ReturnType<typeof hybridMemorySearch>> = [];
  if (userQuery) {
    try {
      searchResults = await hybridMemorySearch(userQuery, {
        limit: 12,
        db,
        sqlite,
      });
    } catch (err) {
      console.warn("[prompt] Hybrid search error during prompt synthesis:", err);
    }
  }

  // Layer 2: Learned procedural mistake-prevention rules
  let proceduralRulesBlock = "";
  try {
    const proceduralSnippets: string[] = [];
    for (const res of searchResults) {
      if (
        res.type === "semantic" &&
        (res.content.includes("MISTAKE TO AVOID") ||
          res.content.includes("PROCEDURAL RULE") ||
          res.content.toLowerCase().includes("procedural"))
      ) {
        proceduralSnippets.push(`• ${res.content}`);
      }
    }

    // Also query top recent semantic memories tagged with procedural_rule if not enough found
    if (proceduralSnippets.length < 5) {
      const dbRules = await db
        .select()
        .from(semanticMemories)
        .where(like(semanticMemories.tags, "%procedural_rule%"))
        .orderBy(desc(semanticMemories.importance), desc(semanticMemories.updatedAt))
        .limit(10);

      for (const rule of dbRules) {
        const item = `• ${rule.content}`;
        if (!proceduralSnippets.includes(item)) {
          proceduralSnippets.push(item);
        }
      }
    }

    if (proceduralSnippets.length > 0) {
      const boundedRules = truncateToTokenBudget(
        proceduralSnippets,
        budgets.proceduralTokens
      );
      if (boundedRules.length > 0) {
        proceduralRulesBlock = `\n\n<learned_rules_and_mistakes_to_avoid>\n${boundedRules.join(
          "\n"
        )}\n</learned_rules_and_mistakes_to_avoid>`;
      }
    }
  } catch (err) {
    console.warn("[prompt] Failed to retrieve procedural rules:", err);
  }

  // Layer 3: Semantic user profile and preferences
  let userProfileBlock = "";
  try {
    const preferences = await db
      .select()
      .from(semanticMemories)
      .where(like(semanticMemories.tags, "%preference%"))
      .orderBy(desc(semanticMemories.importance), desc(semanticMemories.updatedAt))
      .limit(10);

    const preferenceSnippets = preferences.map((p) => `• ${p.content}`);
    if (preferenceSnippets.length > 0) {
      const boundedPreferences = truncateToTokenBudget(
        preferenceSnippets,
        budgets.preferenceTokens
      );
      if (boundedPreferences.length > 0) {
        userProfileBlock = `\n\n<user_profile_and_preferences>\n${boundedPreferences.join(
          "\n"
        )}\n</user_profile_and_preferences>`;
      }
    }
  } catch (err) {
    console.warn("[prompt] Failed to retrieve user preferences:", err);
  }

  // Layer 4: Active unexpired working memory and relevant episodic context
  let cognitiveContextBlock = "";
  try {
    const activeWorking = await getActiveWorkingMemories(db);
    const workingSnippets = activeWorking.map(
      (w) => `• [Working]: ${w.content}`
    );

    const episodicSnippets = searchResults
      .filter(
        (r) =>
          r.type === "episodic" ||
          (!r.content.includes("MISTAKE TO AVOID") &&
            !r.content.includes("PROCEDURAL RULE"))
      )
      .slice(0, 5)
      .map((r) => `• [${r.type}]: ${r.content}`);

    const allContextItems = [...workingSnippets, ...episodicSnippets];
    if (allContextItems.length > 0) {
      const boundedContext = truncateToTokenBudget(
        allContextItems,
        budgets.contextTokens
      );
      if (boundedContext.length > 0) {
        cognitiveContextBlock = `\n\n<cognitive_memory_context>\n${boundedContext.join(
          "\n"
        )}\n</cognitive_memory_context>`;
      }
    }
  } catch (err) {
    console.warn("[prompt] Failed to retrieve cognitive context:", err);
  }

  return (
    baseBehavioralPrompt +
    skillsCatalogBlock +
    proceduralRulesBlock +
    userProfileBlock +
    cognitiveContextBlock
  );
}
