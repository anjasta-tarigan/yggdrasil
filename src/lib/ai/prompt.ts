import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { semanticMemories } from "@/db/schema";
import { desc, like, or } from "drizzle-orm";
import { getActiveWorkingMemories } from "@/lib/memory/working-memory";
import { hybridMemorySearch } from "@/lib/memory/search";
import {
  buildSkillsCatalogBlock,
  truncateToTokenBudget,
} from "@/lib/skills/catalog";
import { resolveActivePersona } from "@/lib/persona-service";
import type { ResolvedLocation } from "@/lib/location/geocoding";
import { loadPromptFile } from "@/lib/ai/prompt-loader";
import { neutralizeDelimiters } from "@/lib/ai/untrusted-content";
import { detectLanguage } from "@/lib/text/language";

/**
 * Neutralizes delimiter look-alikes in each recalled snippet before it is
 * joined into a runtime block.
 *
 * Memory rows are written by reflection over conversation and fetched web
 * content, so a hostile page can seed a "fact" whose text closes
 * `<cognitive_memory_context>` and opens a forged `<system_invariants>`. The
 * block tags are in the reserved list, so neutralizing each snippet keeps every
 * block's own closing tag the only one that parses.
 */
function neutralizeSnippets(snippets: string[]): string[] {
  return snippets.map((snippet) => neutralizeDelimiters(snippet));
}

export interface ModelEnvironmentContext {
  modelId?: string;
  displayName?: string;
  providerName?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsReasoning?: boolean | null;
  supportsToolCalls?: boolean | null;
}

export interface PromptBudgetConfig {
  baseTokens?: number;
  skillsTokens?: number;
  proceduralTokens?: number;
  preferenceTokens?: number;
  projectTokens?: number;
  contextTokens?: number;
}

export interface PromptSynthesisOptions {
  userQuery?: string;
  db?: AppDatabase;
  sqlite?: Database.Database;
  budgets?: PromptBudgetConfig;
  activeTools?: string[];
  modelContext?: ModelEnvironmentContext;
  deviceLocation?: ResolvedLocation;
  now?: Date;
}

const DEFAULT_BUDGETS: Required<PromptBudgetConfig> = {
  baseTokens: 3000,
  skillsTokens: 800,
  proceduralTokens: 800,
  preferenceTokens: 500,
  projectTokens: 600,
  contextTokens: 1200,
};

/**
 * Builds the <model_environment> block describing the runtime engine.
 *
 * Framed as infrastructure metadata, not as identity: the engine named here is
 * an implementation detail of the deployment. Labelling it `Active Model` made
 * it read as "this is who you are", which reinforced the engine vendor's own
 * training identity over the configured persona. The identity rule in the
 * invariants points here for capabilities only.
 */
function buildModelEnvironmentBlock(modelContext?: ModelEnvironmentContext): string {
  if (!modelContext || (!modelContext.modelId && !modelContext.displayName)) {
    return "";
  }

  const identityParts: string[] = [];
  if (modelContext.displayName) {
    identityParts.push(modelContext.displayName);
  }
  if (modelContext.modelId && modelContext.modelId !== modelContext.displayName) {
    identityParts.push(`(id: ${modelContext.modelId})`);
  }
  if (modelContext.providerName) {
    identityParts.push(`via ${modelContext.providerName}`);
  }

  const lines: string[] = [
    `<model_environment>`,
    `Runtime engine (infrastructure metadata, not your identity): ${identityParts.join(" ")}`,
  ];

  const specs: string[] = [];
  if (modelContext.contextWindow) {
    specs.push(`Context Window: ${modelContext.contextWindow.toLocaleString()} tokens`);
  }
  if (modelContext.maxOutputTokens) {
    specs.push(`Max Output: ${modelContext.maxOutputTokens.toLocaleString()} tokens`);
  }
  if (modelContext.supportsReasoning !== undefined && modelContext.supportsReasoning !== null) {
    specs.push(`Reasoning: ${modelContext.supportsReasoning ? "enabled" : "unsupported"}`);
  }
  if (modelContext.supportsToolCalls !== undefined && modelContext.supportsToolCalls !== null) {
    specs.push(`Tool Calling: ${modelContext.supportsToolCalls ? "supported" : "unsupported"}`);
  }

  if (specs.length > 0) {
    lines.push(specs.join(" | "));
  }

  lines.push(`</model_environment>`);
  return lines.join("\n");
}

/**
 * Formats the temporal anchor informing the model of current date, day of week,
 * year and time to eliminate temporal hallucinations.
 */
function buildTemporalAnchorBlock(now: Date = new Date()): string {
  const isoUtc = now.toISOString();
  const dateStr = now.toUTCString();
  const year = now.getUTCFullYear();

  return [
    `<temporal_anchor>`,
    `Current System Time (UTC): ${isoUtc}`,
    `Reference Date: ${dateStr}`,
    `Current Year: ${year}`,
    `</temporal_anchor>`,
  ].join("\n");
}

/**
 * Builds dynamic tool protocols conditioned strictly on active/enabled tools.
 * If activeTools is undefined, defaults to including guidelines for all standard tools.
 */
function buildToolProtocolsBlock(activeTools?: string[]): string {
  const hasTool = (name: string): boolean => {
    if (!activeTools) return true;
    return activeTools.includes(name);
  };

  const hasAnyToolMatching = (predicate: (name: string) => boolean): boolean => {
    if (!activeTools) return true;
    return activeTools.some(predicate);
  };

  const protocols: string[] = [];

  // 1. Web research & verification
  if (hasTool("web_search") || hasTool("web_fetch")) {
    protocols.push(
      `1. Web Research & Verification ('web_search', 'web_fetch'):\n` +
      `   - Proactively execute 'web_search' as your first step whenever a question involves current events, recent software/library versions, API syntax, live data, documentation, or facts outside your training cutoff.\n` +
      `   - Do NOT wait for the user to say "search the web" or ask permission to search. Take autonomous initiative.\n` +
      `   - After searching, use 'web_fetch' to inspect full details of authoritative URLs when snippets are insufficient.\n` +
      `   - When referencing search findings, cite the exact source URLs.`
    );
  }

  // 1b. Specialized MCP capability tools — namespaced variants of web_search/web_fetch
  // exposed under a server slug prefix (e.g. brave__web_search). These coexist
  // with the built-in tools; the prompt directs the model to call the primary
  // MCP variant first, falling back to the built-in within the same turn.
  const capabilityToolPrefixes = new Set<string>();
  if (activeTools) {
    for (const tool of activeTools) {
      const sep = tool.indexOf("__");
      if (sep > 0) {
        const cap = tool.slice(sep + 2);
        if (cap === "web_search" || cap === "web_fetch") {
          capabilityToolPrefixes.add(tool.slice(0, sep));
        }
      }
    }
  }
  if (capabilityToolPrefixes.size > 0) {
    const prefixList = [...capabilityToolPrefixes].sort();
    const toolNames = prefixList.flatMap((p) => [
      `${p}__web_search`,
      `${p}__web_fetch`,
    ]);
    protocols.push(
      `1b. Specialized MCP Capability Tools (${toolNames.join(", ")}):\n` +
      `   - When a primary MCP capability server is configured, prefer calling its namespaced tool first (e.g. '${prefixList[0]}__web_search').\n` +
      `   - If the MCP tool fails or returns insufficient results, immediately fall back to the built-in 'web_search' or 'web_fetch' within the same turn — both are available.\n` +
      `   - Use the MCP variant when its server is reachable and the built-in as a reliable fallback on any error.`
    );
  }

  // 1c. Real Image Search & Visual Retrieval
  if (hasTool("image_search")) {
    protocols.push(
      `1c. Real Image Search & Visual Retrieval ('image_search'):\n` +
      `   - Use image search selectively: For ordinary visual-reference requests, perform ONE focused image search and display only the single best image by default. Display a second image only when it adds meaningful visual information. Never expose more than 2 images unless the user explicitly requests more (e.g., 'Show me 10 photos of...').\n` +
      `   - One query per user request: For a single visual intent, perform ONE focused query by default. Do NOT execute multiple queries (e.g. 'tube computer', 'vacuum tube computer', 'early tube computer') merely to increase images. Only perform multiple queries if comparing distinct subjects (e.g. comparing ENIAC and UNIVAC).\n` +
      `   - Prioritize authoritative sources over quantity: Primary manufacturers, museums, universities, government archives, and reputable institutions are ranked first.\n` +
      `   - Construct precise, specific queries (e.g., prefer 'NVIDIA GeForce RTX 5090 official product photo' over 'RTX', or 'early vacuum tube computer historical photograph' over 'computer').\n` +
      `   - Do NOT invoke 'image_search' for purely textual questions, mathematics, programming/debugging where images add no value, translations, or requests to create/generate an original image.\n` +
      `   - Response ordering: Retrieved images render FIRST, immediately above your explanation (Images first → AI explanation second). Provide a natural textual answer below the image(s). Never dump raw tool JSON or markdown image links.`
    );
  }

  // 2. Deliverables & Artifacts
  if (hasTool("artifact_publish")) {
    protocols.push(
      `2. Standalone Deliverables & Artifacts ('artifact_publish'):\n` +
      `   - 'artifact_publish' renders standalone deliverables into a dedicated side-panel preview for the user.\n` +
      `   - Whenever asked to create, build, generate, or sample an artifact, code file, script, HTML/JS/CSS interactive app/demo, SVG graphic, React component, full document, or multi-file project bundle, you MUST call 'artifact_publish'.\n` +
      `   - STRICT PROHIBITION: NEVER output complete code files or interactive demos as markdown code blocks in your chat response. Place them inside 'artifact_publish'.\n` +
      `   - In your chat text response, provide only a brief 1-2 sentence overview; the full content must live inside the artifact tool call.\n` +
      `   - Only use inline code blocks for tiny snippets (1-5 lines) or inline terminal commands.`
    );
  }

  // 3. Sandbox Workspace
  if (hasTool("bash") || hasTool("readFile") || hasTool("writeFile")) {
    protocols.push(
      `3. Workspace & Sandbox Execution ('bash', 'readFile', 'writeFile'):\n` +
      `   - The sandbox provides a confined local environment (data/sandbox) for running bash commands and inspecting or manipulating files.\n` +
      `   - Use sandbox tools when the user asks to run scripts, compile code, execute tests, or inspect local workspace files.\n` +
      `   - Prefer 'artifact_publish' for deliverables the user wants to visually view, copy, or interact with in the UI side panel.`
    );
  }

  // 4. Subagent Delegation
  if (hasAnyToolMatching((name) => name.startsWith("delegate_"))) {
    protocols.push(
      `4. Specialist Subagent Delegation ('delegate_*'):\n` +
      `   - Specialized subagents run in focused, isolated contexts with tailored toolsets (e.g., deep research or complex coding).\n` +
      `   - Delegate heavy multi-step research or extensive code generation to the appropriate subagent when available, synthesizing their results for the user.`
    );
  }

  // 5. Task Management
  if (hasTool("task_list_manager")) {
    protocols.push(
      `5. Task Planning & Checklists ('task_list_manager'):\n` +
      `   - For complex, multi-step tasks or non-trivial implementations, invoke 'task_list_manager' with all items marked pending before executing.\n` +
      `   - Update the task list as progress occurs, marking items in_progress or completed.`
    );
  }

  // 6. Interactive Clarifications
  if (hasTool("ask_user_question")) {
    protocols.push(
      `6. Structured Questionnaires ('ask_user_question'):\n` +
      `   - When a task is underspecified, has multiple valid architectural approaches, or requires design choices, call 'ask_user_question' to present structured multiple-choice options. Do not guess user preferences.`
    );
  }

  // 7. Reminders & Scheduled Follow-ups
  if (hasTool("reminder_schedule")) {
    protocols.push(
      `7. Timed Reminders ('reminder_schedule'):\n` +
      `   - When the user asks to be reminded or followed up with at a future time or interval, call 'reminder_schedule' with the relative delay in minutes.`
    );
  }

  // 8. System Entity Management (cron, subagents, MCP servers)
  if (hasTool("manage_subagent") && hasTool("manage_cron_schedule") && hasTool("manage_mcp_server")) {
    protocols.push(
      `8. System Entity Management ('manage_subagent', 'manage_cron_schedule', 'manage_mcp_server'):\n` +
      `   - When the user asks to create, update, delete, or list subagents, cron schedules, or MCP servers, call the corresponding manage_* tool directly — these persist to the SQLite settings store and take effect immediately (no restart required).\n` +
      `   - manage_subagent: creates a subagent with its own model, instructions, tool grants, and step budget. An enabled subagent automatically gets a 'delegate_<name>' tool on the next turn via buildSubagentToolsForChat().\n` +
      `   - manage_cron_schedule: creates a recurring schedule (5-field cron expression → queue job type). The cognitive daemon re-arms live on every mutation via syncCognitiveDaemon(). Use action 'run' to trigger an immediate one-shot execution.\n` +
      `   - manage_mcp_server: adds/updates/deletes MCP server configs. MCP tools from enabled servers are automatically collected per-request via collectMcpTools() and injected as slug-prefixed tools (e.g. 'myserver__web_search'). Deleting a server also clears its approved baseline.\n` +
      `   - Destructive actions (update, delete) require user approval before execution.`
    );
  }

  // 9. Custom Dynamic Tools
  if (hasTool("manage_custom_tool")) {
    protocols.push(
      `9. Custom Dynamic Tools ('manage_custom_tool'):\n` +
      `   - When the user asks to create, update, delete, or list custom tools, call 'manage_custom_tool' directly — these persist to settings and become available on subsequent chat turns.\n` +
      `   - create: requires name, description, JSON schema (object type), and execution config (type 'http', url, method, optional headers/timeoutMs/allowLoopback).\n` +
      `   - update: requires id and any fields to modify (name, description, enabled, schema, execution).\n` +
      `   - delete: requires id to remove a custom tool.\n` +
      `   - list: returns all configured custom tools (secrets are masked).`
    );
  }

  if (protocols.length === 0) {
    return "";
  }

  return (
    `<tool_protocols>\n` +
    `The following protocols govern your tool usage. Strictly adhere to them for all active capabilities:\n\n` +
    protocols.join("\n\n") +
    `\n</tool_protocols>`
  );
}

function buildDeviceLocationBlock(location?: ResolvedLocation): string {
  if (!location) return "";

  // Address fields come from a third-party reverse geocoder (Nominatim), so
  // they are external text landing in trusted prompt markup. Neutralize
  // delimiter look-alikes so a crafted place name cannot close this block and
  // forge a section such as <system_invariants>.
  const safe = (value: string): string => neutralizeDelimiters(value);

  const lines = [
    "<device_location>",
    `Source: ${location.source === "device_gps" ? "device_gps (high accuracy)" : location.source}`,
  ];

  if (location.coordinates) {
    lines.push(
      `Coordinates: ${location.coordinates.latitude.toFixed(4)}, ${location.coordinates.longitude.toFixed(4)}${
        location.coordinates.accuracyMeters ? ` (±${Math.round(location.coordinates.accuracyMeters)}m)` : ""
      }`
    );
  } else if (location.note) {
    lines.push(`Coordinates: unavailable (${safe(location.note)})`);
  }

  if (location.address) {
    if (location.address.city) lines.push(`City: ${safe(location.address.city)}`);
    if (location.address.region) lines.push(`Region: ${safe(location.address.region)}`);
    if (location.address.country) lines.push(`Country: ${safe(location.address.country)}`);
    if (location.address.formatted) lines.push(`Address: ${safe(location.address.formatted)}`);
  }

  if (location.timezone) {
    lines.push(`Timezone: ${safe(location.timezone)}`);
  }

  lines.push(
    "Note: Use these coordinates/city when answering location-sensitive queries. You can also call the get_device_location tool for real-time refreshed positioning or details.",
    "</device_location>"
  );

  return lines.join("\n");
}

/**
 * Synthesizes the dynamic system prompt with strict token budgets and prefix-cache ordering:
 * 1. Base behavioral invariants and objective communication standards (Static top prefix)
 * 2. Active persona directives — static, placed immediately after invariants so that
 *    1+2 form the immutable bytes-0..N prefix (see system-persona spec §3.1/§3.3)
 * 3. Model environment & capabilities auto-detection (dynamic)
 * 4. Dynamic tool protocols (conditioned on active tools)
 * 5. Skills catalog with on-demand skill guidance
 * 6. Runtime context (Temporal anchor, Learned procedural rules, User profile, Working memory)
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

  // Layer 1: Core System Invariants & Operating Baseline (Static Prefix for Optimal Caching)
  // Loaded from prompts/invariants.yaml — falls back to inline hardcoded strings
  // if the YAML file is missing or unparseable. This is the only layer with
  // hardcoded rules that CANNOT be modified via persona, skills, or memory.
  const coreInvariantsBody = loadPromptFile("invariants");
  const coreInvariants = `<system_invariants>\n${coreInvariantsBody}\n</system_invariants>`;

  // Layer 2: Model Environment (Auto-detected capabilities & runtime identity)
  const modelEnvBlock = buildModelEnvironmentBlock(options.modelContext);

  // Layer 3: Dynamic Tool Protocols (Conditioned on active tools)
  const toolProtocolsBlock = buildToolProtocolsBlock(options.activeTools);

  // Layer 4: Installed Skills Catalog with Skill Recognition
  let skillsCatalogBlock = "";
  try {
    skillsCatalogBlock = await buildSkillsCatalogBlock({
      db,
      budgetTokens: budgets.skillsTokens,
    });
  } catch (err) {
    console.warn("[prompt] Failed to build skills catalog block:", err);
  }

  // Inject skill usage directive only when skills are present
  let proactiveSkillsDirective = "";
  if (skillsCatalogBlock.length > 0) {
    proactiveSkillsDirective = `\n<skill_usage_principles>
When a task clearly matches an installed skill in <available_skills>, call 'use_skill' to load its instructions before proceeding.
</skill_usage_principles>`;
  }

  // Layer 1 (static prefix): Active Persona & Identity.
  // Per the system-persona spec (§3.1/§3.3), invariants are placed first with
  // explicit superseding language, followed *immediately* by the static custom
  // persona. Together they form the immutable prefix at bytes 0..N of the
  // system prompt, which is what makes the ~90% prompt-cache hit rate possible.
  // Persona MUST therefore precede the dynamic blocks below.
  const { name: personaName, instructions: personaInstructions } =
    await resolveActivePersona(db);

  // The persona is operator-authored, so its intent is trusted — but it is
  // still free text interpolated into prompt markup. Neutralizing delimiter
  // look-alikes stops a persona from closing this block early and forging a
  // later `<system_invariants>` section, which would undercut the
  // "invariants come first" precedence the prompt relies on.
  const personaBlock = `<persona_directives>
Assistant Identity: ${neutralizeDelimiters(personaName)}
${neutralizeDelimiters(personaInstructions)}
</persona_directives>`;

  // Truncate non-core dynamic sections if necessary, but guarantee coreInvariants
  // and personaBlock are always preserved (they are not part of secondaryBlocks).
  const secondaryBlocks = [
    modelEnvBlock,
    toolProtocolsBlock,
    skillsCatalogBlock + proactiveSkillsDirective,
  ].filter((s) => s.length > 0);

  const availableTokensForSecondary = Math.max(
    budgets.baseTokens - 400,
    200
  );

  const boundedSecondary = truncateToTokenBudget(
    secondaryBlocks,
    availableTokensForSecondary
  );

  const topSections = [
    coreInvariants,
    personaBlock,
    ...boundedSecondary,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");

  const baseBehavioralPrompt = topSections;

  // Single hybrid search retrieval pass across memory tiers
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

  // Layer 6: Dynamic Runtime Context (Placed at bottom for prefix cache preservation)
  const temporalAnchorBlock = buildTemporalAnchorBlock(options.now);

  // Layer 6a: Learned procedural mistake-prevention rules
  let proceduralRulesBlock = "";
  try {
    const proceduralSnippets: string[] = [];
    for (const res of searchResults) {
      if (
        res.type === "semantic" &&
        (res.content.includes("MISTAKE TO AVOID") ||
          res.content.includes("PROCEDURAL RULE") ||
          res.content.toLowerCase().includes("procedural")) &&
        detectLanguage(res.content) !== "id"
      ) {
        proceduralSnippets.push(`• ${res.content}`);
      }
    }

    if (proceduralSnippets.length < 5) {
      const dbRules = await db
        .select()
        .from(semanticMemories)
        .where(like(semanticMemories.tags, "%procedural_rule%"))
        .orderBy(desc(semanticMemories.importance), desc(semanticMemories.updatedAt))
        .limit(10);

      for (const rule of dbRules) {
         const item = `• ${rule.content}`;
         // Phase 6: Exclude Indonesian-content memories from system prompt to
         // prevent language contamination. All system prompt layers must remain
         // English; only the user's response language should be Indonesian.
         if (!proceduralSnippets.includes(item) && detectLanguage(rule.content) !== "id") {
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
        proceduralRulesBlock = `\n\n<learned_rules_and_mistakes_to_avoid>\n${neutralizeSnippets(
          boundedRules
        ).join("\n")}\n</learned_rules_and_mistakes_to_avoid>`;
      }
    }
  } catch (err) {
    console.warn("[prompt] Failed to retrieve procedural rules:", err);
  }

  // Layer 6b: Semantic user profile and preferences.
  //
  // Preferences live in TWO places, and both must be queried. Reflection
  // writes the machine-readable `metadata.category` ("user_preference",
  // set on every reflection row) but only sometimes mirrors it into `tags`
  // (52 rows carry the category in the live store; 2 carry a matching tag).
  // A tags-only query therefore misses nearly all of them.
  let userProfileBlock = "";
  try {
    const preferences = await db
      .select()
      .from(semanticMemories)
      .where(
        or(
          like(semanticMemories.tags, "%preference%"),
          like(semanticMemories.metadata, "%user_preference%")
        )
      )
      .orderBy(desc(semanticMemories.importance), desc(semanticMemories.updatedAt))
      .limit(10);

    const preferenceSnippets = preferences
      .filter((p) => detectLanguage(p.content) !== "id")
      .map((p) => `• ${p.content}`);
    if (preferenceSnippets.length > 0) {
      const boundedPreferences = truncateToTokenBudget(
        preferenceSnippets,
        budgets.preferenceTokens
      );
      if (boundedPreferences.length > 0) {
        userProfileBlock = `\n\n<user_profile_and_preferences>\n${neutralizeSnippets(
          boundedPreferences
        ).join("\n")}\n</user_profile_and_preferences>`;
      }
    }
  } catch (err) {
    console.warn("[prompt] Failed to retrieve user preferences:", err);
  }

  // Layer 6b2: Project facts and domain knowledge.
  //
  // These two categories (58 + 79 rows in the live store) were never surfaced
  // by any prompt query. They carry project-scoped facts ("the project uses
  // X") and reusable technical knowledge that the model should recall without
  // a hybrid-search hit, so they get their own block and token budget.
  let projectKnowledgeBlock = "";
  try {
    const projectFacts = await db
      .select()
      .from(semanticMemories)
      .where(
        or(
          like(semanticMemories.metadata, "%project_fact%"),
          like(semanticMemories.metadata, "%domain_knowledge%")
        )
      )
      .orderBy(desc(semanticMemories.importance), desc(semanticMemories.updatedAt))
      .limit(10);

    const projectSnippets = projectFacts
      .filter((p) => detectLanguage(p.content) !== "id")
      .map((p) => `• ${p.content}`);
    if (projectSnippets.length > 0) {
      const boundedProject = truncateToTokenBudget(
        projectSnippets,
        budgets.projectTokens
      );
      if (boundedProject.length > 0) {
        projectKnowledgeBlock = `\n\n<project_and_domain_knowledge>\n${neutralizeSnippets(
          boundedProject
        ).join("\n")}\n</project_and_domain_knowledge>`;
      }
    }
  } catch (err) {
    console.warn("[prompt] Failed to retrieve project knowledge:", err);
  }

  // Layer 6c: Active unexpired working memory and relevant episodic context
  let cognitiveContextBlock = "";
  try {
    const activeWorking = await getActiveWorkingMemories(db);
    const workingSnippets = activeWorking
      .filter((w) => detectLanguage(w.content) !== "id")
      .map((w) => `• [Working]: ${w.content}`);

    // Ephemeral conversational-context memories (rolling summaries, consolidated
    // session recaps, transient working-state) are ALREADY handled separately:
    // rolling summaries are injected into the first user message via
    // getRollingSummary(). Injecting their full conversation transcripts here
    // would (a) duplicate context, (b) introduce unconversational Indonesian/
    // English prose into the system prompt, and (c) risk mid-sentence truncation
    // that produces ambiguous, style-contaminated output. They are excluded.
    const EPHEMERAL_TAGS = new Set([
      "rolling_summary",
      "consolidated_memory",
    ]);

    const episodicSnippets = searchResults
      .filter(
        (r) =>
          // Exclude ephemeral conversational transcripts FIRST (always)
          !r.tags?.some((t) => EPHEMERAL_TAGS.has(t)) &&
          // Phase 6: Exclude Indonesian-content memories from system prompt
          // to prevent language contamination. All system-level instructions
          // in this prompt are English; only the user's response language is
          // Indonesian. Retrieved facts are DATA only — never adopt their language.
          detectLanguage(r.content) !== "id" &&
          // Then apply existing exclusion logic for procedural rules
          (r.type === "episodic" ||
            (!r.content.includes("MISTAKE TO AVOID") &&
              !r.content.includes("PROCEDURAL RULE")))
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
        cognitiveContextBlock = `\n\n<cognitive_memory_context>\n${neutralizeSnippets(
          boundedContext
        ).join("\n")}\n</cognitive_memory_context>`;
      }
    }
  } catch (err) {
    console.warn("[prompt] Failed to retrieve cognitive context:", err);
  }

  const deviceLocationBlock = buildDeviceLocationBlock(options.deviceLocation);

  const runtimeContext =
    `\n\n<runtime_context>\n` +
    temporalAnchorBlock +
    (deviceLocationBlock ? `\n${deviceLocationBlock}` : "") +
    proceduralRulesBlock +
    userProfileBlock +
    projectKnowledgeBlock +
    cognitiveContextBlock +
    `\n</runtime_context>`;

  return `${baseBehavioralPrompt}${runtimeContext}`;
}

/**
 * Extracts learned procedural rules and user preferences from semantic memory
 * so they can be passed to `classifyTaskReasoningEffort`'s self-improvement
 * layer. This closes the gap where the reasoning classifier had the
 * self-improvement interface but was never fed any learned context in
 * production (route.ts only passed `{ activeTools }`).
 */
export async function extractLearnedRulesAndPreferences(
  dbInstance: AppDatabase = defaultDb
): Promise<{ rules: string[]; preferences: string[] }> {
  try {
    const rules = await dbInstance
      .select({ content: semanticMemories.content })
      .from(semanticMemories)
      .where(like(semanticMemories.tags, "%procedural_rule%"))
      .orderBy(desc(semanticMemories.importance), desc(semanticMemories.updatedAt))
      .limit(10);

    const preferences = await dbInstance
      .select({ content: semanticMemories.content })
      .from(semanticMemories)
      .where(
        or(
          like(semanticMemories.tags, "%preference%"),
          like(semanticMemories.metadata, "%user_preference%")
        )
      )
      .orderBy(desc(semanticMemories.importance), desc(semanticMemories.updatedAt))
      .limit(10);

    return {
      rules: rules
        .filter((r) => detectLanguage(r.content) !== "id")
        .map((r) => r.content),
      preferences: preferences
        .filter((p) => detectLanguage(p.content) !== "id")
        .map((p) => p.content),
    };
  } catch (err) {
    console.warn("[prompt] Failed to extract learned rules/preferences:", err);
    return { rules: [], preferences: [] };
  }
}
