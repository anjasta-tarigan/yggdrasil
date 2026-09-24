import { db as defaultDb, type AppDatabase } from "@/db";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { syslog } from "@/lib/observability/log-store";
import {
  getProviderById,
  ProviderConfigError,
} from "@/lib/ai/provider-config/store";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import { decodeModelRef } from "@/lib/settings";
import { SANDBOX_TOOL_NAMES } from "./tool-names";

/**
 * User-managed subagents — the modular delegation layer.
 *
 * A subagent is a `ToolLoopAgent` (AI SDK v7) the main chat model can invoke
 * through a generated tool call. Each subagent runs with its OWN context
 * window, its own instruction set, and a restricted subset of tools, then
 * returns a focused summary to the main agent — exactly the
 * context-offloading pattern from the AI SDK v7 subagents guide.
 *
 * Configs live in the settings table under "subagents" so they survive
 * restarts and can be managed at runtime from the Subagents page. The
 * chat route builds one delegation tool per ENABLED subagent before each
 * request; disabling or editing a subagent applies on the next turn.
 *
 * Built-in seeds demonstrate the three archetypes:
 *  - researcher: read-heavy exploration (web + memory), summarizes
 *  - coder: sandboxed execution (bash/read/write files)
 *  - analyst: deep analysis with memory recall, structured conclusions
 */

export type SubagentId = string;

/**
 * Tool capability groups a subagent can be granted.
 *
 * NOTE: an "artifacts" (artifact_publish) grant is NOT offered: artifacts
 * created inside a subagent land only in its nested UIMessage, which the
 * main chat's artifact chip scan does not recurse into — a granted-but-
 * invisible capability is worse than an unlisted one. Re-add the entry
 * together with nested-artifact rendering in SubagentInvocation.
 */
export type SubagentToolKey =
  | "web_search"
  | "web_fetch"
  | "memory"
  | "sandbox"
  | "tasks";

/**
 * The tool registry: every grantable capability with the exact tool names
 * wired into the subagent's toolset at build time (see subagent-runner.ts).
 * Names map 1:1 onto chatTools / createSandboxTools entries.
 */
export const SUBAGENT_TOOL_REGISTRY: ReadonlyArray<{
  key: SubagentToolKey;
  label: string;
  description: string;
  toolNames: readonly string[];
}> = [
  {
    key: "web_search",
    label: "Web Search",
    description: "Multi-provider web search (Exa/Firecrawl/SearXNG)",
    toolNames: ["web_search"],
  },
  {
    key: "web_fetch",
    label: "Fetch Page",
    description: "Read a specific URL as markdown",
    toolNames: ["web_fetch"],
  },
  {
    key: "memory",
    label: "Memory",
    description: "Recall long-term memories and notes",
    toolNames: ["memory_search", "memory_note_create"],
  },
  {
    key: "sandbox",
    label: "Sandbox",
    description: "bash / readFile / writeFile in the data/sandbox workspace",
    toolNames: SANDBOX_TOOL_NAMES,
  },
  {
    key: "tasks",
    label: "Task Checklist",
    description: "Visible plan/task checklist tool",
    toolNames: ["task_list_manager"],
  },
];

/** Expand capability keys to the real tool names for tool descriptions. */
export function toolNamesForKeys(keys: readonly SubagentToolKey[]): string[] {
  const names = new Set<string>();
  for (const key of keys) {
    const entry = SUBAGENT_TOOL_REGISTRY.find((t) => t.key === key);
    if (!entry) continue;
    for (const name of entry.toolNames) names.add(name);
  }
  return [...names];
}

const TOOL_KEY_SET: ReadonlySet<string> = new Set(
  SUBAGENT_TOOL_REGISTRY.map((t) => t.key)
);

/** Stored subagent configuration. */
export interface SubagentConfig {
  /** Stable unique id (nanoid). */
  id: SubagentId;
  /** Human label shown in the UI and used to name the delegation tool. */
  name: string;
  /** The subagent's system instructions (its persona + summarization brief). */
  instructions: string;
  /** Granted tool capability groups. */
  tools: SubagentToolKey[];
  /** Enabled subagents get a delegation tool in the next chat turn. */
  enabled: boolean;
  /** Optional model override ("providerId::modelId" ref or bare model id). */
  model?: string;
  /** Max autonomous steps the subagent may take (loop control). */
  maxSteps: number;
  /** Free-form note shown under the name in the UI. */
  description?: string;
  /**
   * Delegation guidance interpolated into the tool description the MAIN
   * model reads (single source of truth — the runner never sniffs names).
   * When absent the runner uses a generic brief.
   */
  delegationGuidance?: string;
  createdAt: string;
  updatedAt: string;
  /** Whether this row came from the built-in seed (informational only). */
  builtIn?: boolean;
}

/** Settings key under which the subagent list is persisted. */
const SUBAGENTS_SETTINGS_KEY = "subagents";

/** Bound the stored list to keep the settings row sane. */
const MAX_SUBAGENTS = 20;
const MIN_STEPS = 1;
const MAX_STEPS_LIMIT = 50;

/** Built-in seed subagents (the three archetypes). */
export const BUILT_IN_SUBAGENTS: ReadonlyArray<
  Omit<SubagentConfig, "id" | "createdAt" | "updatedAt">
> = [
  {
    name: "Researcher",
    instructions: `You are a research agent. Complete the assigned task autonomously using the tools available.

Method:
1. Start with memory_search for relevant prior knowledge, then web_search for current external facts.
2. For any result that matters, web_fetch the source to verify — do not rely on snippets for key claims.
3. Prefer authoritative sources (official docs, specs, repositories) over secondary summaries.
4. Cross-check important facts across at least two independent sources when feasible.

Budget your steps: keep enough of your max-step budget to write the final summary.

IMPORTANT: When you have finished, write a clear summary of your findings as your final response, ending with a line "SUMMARY COMPLETE.".
This summary will be returned to the main agent, so include all relevant information, cite sources where applicable, and keep it focused and dense. State explicitly when something could not be verified or sources conflicted.`,
    tools: ["web_search", "web_fetch", "memory"],
    enabled: true,
    maxSteps: 24,
    description:
      "Explores the web and long-term memory in depth, verifies sources, returns a cited summary",
    delegationGuidance:
      "USE for: multi-source research (comparing options, gathering current versions/releases, library/API details, 'what is the best/latest X' questions), any task needing 3+ web sources, fact-checking, or deep recall from long-term memory. DO NOT USE for: questions answerable from a single web search or from your existing knowledge.",
    builtIn: true,
  },
  {
    name: "Coder",
    instructions: `You are a coding agent working inside a sandboxed workspace. Build, run, and test code with the bash/shell and file tools. Iterate until the task works.

IMPORTANT: When you have finished, write a clear summary as your final response: what you built, the key files, how to run it, and any caveats. This summary will be returned to the main agent.`,
    tools: ["sandbox", "tasks"],
    enabled: true,
    maxSteps: 20,
    description:
      "Writes and executes code in the sandbox workspace, iterates until it works",
    delegationGuidance:
      "USE for: build-run-test-iterate coding tasks (write a script and verify it runs, prototype a component, debug with execution). DO NOT USE for: single-file edits or questions answerable by reading code you already have.",
    builtIn: true,
  },
  {
    name: "Analyst",
    instructions: `You are an analysis agent. Reason carefully about the assigned task, recall relevant long-term memories for context, and draw structured conclusions.

IMPORTANT: When you have finished, write a clear summary of your analysis as your final response with the key insights, trade-offs, and a recommendation. This summary will be returned to the main agent.`,
    tools: ["memory", "tasks"],
    enabled: false,
    maxSteps: 10,
    description:
      "Deep-thinks a question with memory context, returns structured conclusions",
    delegationGuidance:
      "USE for: nuanced questions needing structured reasoning over remembered context — trade-off analysis, recommendation with justification, weighing options. DO NOT USE for: factual lookups or simple lookups better served by a web search.",
    builtIn: true,
  },
];

/**
 * Runtime shape check for a stored subagent row.
 *
 * Beyond structural shape: the name must also slugify to a non-empty
 * suffix — a hand-edited row whose name has no alphanumerics (e.g. "###")
 * would otherwise pass the shape check and produce a broken `delegate_`
 * tool name at build time.
 */
function isSubagentShape(value: unknown): value is SubagentConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.name !== "string" ||
    v.name.length === 0 ||
    v.name.length > 128 ||
    slugifySubagentName(v.name).length === 0
  ) {
    return false;
  }
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    v.id.length <= 128 &&
    typeof v.instructions === "string" &&
    v.instructions.length > 0 &&
    v.instructions.length <= 20_000 &&
    Array.isArray(v.tools) &&
    v.tools.length > 0 &&
    v.tools.every((t) => typeof t === "string" && TOOL_KEY_SET.has(t)) &&
    typeof v.enabled === "boolean" &&
    (v.model === undefined ||
      (typeof v.model === "string" && v.model.length <= 256)) &&
    typeof v.maxSteps === "number" &&
    Number.isFinite(v.maxSteps) &&
    v.maxSteps >= MIN_STEPS &&
    v.maxSteps <= MAX_STEPS_LIMIT &&
    (v.description === undefined ||
      (typeof v.description === "string" && v.description.length <= 500)) &&
    (v.delegationGuidance === undefined ||
      (typeof v.delegationGuidance === "string" &&
        v.delegationGuidance.length <= 1000)) &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

/**
 * Bump whenever a built-in's instructions/description/guidance changes
 * materially. Existing installs carry a stored "subagents" row that the
 * first-access seed never touches again — without this marker and the
 * refresh pass below, improved seeds would never reach them.
 * v3: built-in tool rename (fetch_page → web_fetch, recall_memories →
 * memory_search) — updated Researcher method text.
 */
const SEED_VERSION = 3;
const SEED_VERSION_KEY = "subagentsSeedVersion";

/**
 * Tool-name pairs from the built-in tool rename. Substituted in stored
 * subagent instruction text so a persona that references a renamed tool
 * keeps pointing at the live tool without discarding the user's edit.
 */
const LEGACY_TOOL_NAME_SUBSTITUTIONS: ReadonlyArray<readonly [string, string]> = [
  ["fetch_page", "web_fetch"],
  ["recall_memories", "memory_search"],
  ["remember_note", "memory_note_create"],
  ["remember_fact", "memory_fact_store"],
  ["forget_note", "memory_note_delete"],
  ["manage_tasks", "task_list_manager"],
  ["create_artifact", "artifact_publish"],
  ["set_reminder", "reminder_schedule"],
];

const LEGACY_TOOL_NAME_SOURCE = LEGACY_TOOL_NAME_SUBSTITUTIONS.map(
  ([from]) => from
).join("|");

/**
 * Detector for "does this text mention any legacy tool name" — plain
 * (non-global) so `.test` carries no lastIndex state between rows.
 */
const LEGACY_TOOL_NAME_RE = new RegExp(LEGACY_TOOL_NAME_SOURCE);

/** Substitution matcher — global so `.replace` rewrites every mention. */
const LEGACY_TOOL_NAME_SUBSTITUTION_RE = new RegExp(
  LEGACY_TOOL_NAME_SOURCE,
  "g"
);

/** Replace every legacy tool-name mention in stored instruction text. */
function rewriteLegacyToolNames(text: string): string {
  return text.replace(LEGACY_TOOL_NAME_SUBSTITUTION_RE, (match) => {
    const pair = LEGACY_TOOL_NAME_SUBSTITUTIONS.find(([from]) => from === match);
    return pair ? pair[1] : match;
  });
}

/**
 * Refresh built-in rows whose seed content is outdated. User edits win:
 * a built-in whose stored row differs from the seed in ANY user-touched
 * field is left alone (the user customized it); only rows that still
 * match the old seed shape get the update. Exception: instruction text
 * that still mentions a legacy tool name is ALWAYS fixed, but surgically
 * for customized rows — only the name mentions are substituted so the
 * user's persona text survives; uncustomized rows get the full seed.
 */
function refreshOutdatedBuiltIns(stored: SubagentConfig[], db: AppDatabase): SubagentConfig[] {
  let changed = false;
  const next = stored.map((row) => {
    if (!row.builtIn) return row;
    const seed = BUILT_IN_SUBAGENTS.find(
      (s) => s.name.toLowerCase() === row.name.toLowerCase()
    );
    if (!seed) return row;

    const hasLegacyToolName = LEGACY_TOOL_NAME_RE.test(row.instructions);

    // Uncustomized-row detection. A row is the previous seed (not a user
    // edit) when either the classic drift signature holds (instructions
    // and maxSteps both differ from the current seed), or its instruction
    // text becomes EXACTLY the current seed once legacy tool names are
    // substituted — a rename-only diff is the old seed's fingerprint.
    const looksLikeOldSeed =
      (row.instructions !== seed.instructions &&
        row.maxSteps !== seed.maxSteps) ||
      (hasLegacyToolName &&
        rewriteLegacyToolNames(row.instructions) === seed.instructions);

    if (looksLikeOldSeed) {
      changed = true;
      return {
        ...row,
        instructions: seed.instructions,
        maxSteps: seed.maxSteps,
        delegationGuidance: seed.delegationGuidance,
        // Tool capability keys are normalized too: a pre-rename row may
        // still carry the old fetch_page key.
        tools: migrateToolKeys(row.tools) as SubagentToolKey[],
        updatedAt: new Date().toISOString(),
      };
    }

    // Customized rows: never overwrite the persona — only rewrite the
    // stale tool-name mentions so they keep pointing at live tools.
    if (hasLegacyToolName) {
      const rewritten = rewriteLegacyToolNames(row.instructions);
      if (rewritten !== row.instructions) {
        changed = true;
        syslog(
          "info",
          "subagents",
          `Rewrote legacy tool names in customized built-in "${row.name}" (instructions preserved)`
        );
        return {
          ...row,
          instructions: rewritten,
          tools: migrateToolKeys(row.tools) as SubagentToolKey[],
          updatedAt: new Date().toISOString(),
        };
      }
    }

    return row;
  });
  if (changed) {
    persistSubagents(next, db);
    setSettingsDb({ [SEED_VERSION_KEY]: SEED_VERSION }, db);
    syslog(
      "info",
      "subagents",
      `Refreshed outdated built-in subagent seeds to version ${SEED_VERSION}`
    );
  }
  return next;
}

/**
 * One-time migration of capability keys renamed by the built-in tool
 * rename (fetch_page → web_fetch). Applied at read time so stored configs
 * from before the rename keep working without a manual edit.
 */
const TOOL_KEY_MIGRATIONS: Readonly<Record<string, SubagentToolKey>> = {
  fetch_page: "web_fetch",
};

function migrateToolKeys(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const seen = new Set<string>();
  const migrated: string[] = [];
  for (const key of value) {
    if (typeof key !== "string") continue;
    const next = TOOL_KEY_MIGRATIONS[key] ?? key;
    if (TOOL_KEY_SET.has(next) && !seen.has(next)) {
      seen.add(next);
      migrated.push(next);
    }
  }
  return migrated;
}

/** Read all subagents; seeds the built-ins on first access. */
export function listSubagents(db: AppDatabase = defaultDb): SubagentConfig[] {
  const stored = getSettingDb(SUBAGENTS_SETTINGS_KEY, db);
  if (stored === undefined) {
    const seeded = seedBuiltInSubagents(db);
    setSettingsDb({ [SEED_VERSION_KEY]: SEED_VERSION }, db);
    return seeded;
  }
  if (!Array.isArray(stored)) return [];

  // Read-time key migration: rows stored before the built-in tool rename
  // fail the shape check on their old capability keys; re-check each row
  // with migrated keys and persist the result once.
  const rows: SubagentConfig[] = [];
  let migratedAny = false;
  for (const row of stored) {
    if (isSubagentShape(row)) {
      rows.push(row);
      continue;
    }
    const migratedTools = migrateToolKeys(
      (row as { tools?: unknown })?.tools
    );
    const candidate = { ...(row as object), tools: migratedTools };
    if (isSubagentShape(candidate)) {
      rows.push(candidate as SubagentConfig);
      migratedAny = true;
    }
  }
  if (migratedAny) persistSubagents(rows, db);

  const seedVersion = getSettingDb(SEED_VERSION_KEY, db);
  if (seedVersion !== SEED_VERSION) {
    return refreshOutdatedBuiltIns(rows, db);
  }
  return rows;
}

/** Enabled subagents only (what the chat route turns into tools). */
export function listEnabledSubagents(
  db: AppDatabase = defaultDb
): SubagentConfig[] {
  return listSubagents(db).filter((s) => s.enabled);
}

/** Insert the built-in defaults; returns what was written. */
function seedBuiltInSubagents(db: AppDatabase): SubagentConfig[] {
  const now = new Date().toISOString();
  const seeded = BUILT_IN_SUBAGENTS.map((entry) => ({
    ...entry,
    id: `sub_${entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
    createdAt: now,
    updatedAt: now,
  }));
  setSettingsDb({ [SUBAGENTS_SETTINGS_KEY]: seeded }, db);
  syslog(
    "info",
    "subagents",
    `Seeded ${seeded.length} built-in subagents (settings key "${SUBAGENTS_SETTINGS_KEY}")`
  );
  return seeded;
}

function persistSubagents(subagents: SubagentConfig[], db: AppDatabase): void {
  setSettingsDb({ [SUBAGENTS_SETTINGS_KEY]: subagents }, db);
}

/** Convert a display name to a safe tool-name suffix (snake_case). */
export function slugifySubagentName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export interface SubagentInput {
  name: string;
  instructions: string;
  tools: SubagentToolKey[];
  enabled?: boolean;
  model?: string;
  maxSteps?: number;
  description?: string;
  /** Routing guidance for the main model (see SubagentConfig). */
  delegationGuidance?: string;
}

/** Validation error carrying per-field messages. */
export class SubagentValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "SubagentValidationError";
    this.issues = issues;
  }
}

/** Validate a create/update payload; returns per-field error strings. */
export async function validateSubagentInput(input: {
  name?: unknown;
  instructions?: unknown;
  tools?: unknown;
  enabled?: unknown;
  model?: unknown;
  maxSteps?: unknown;
  description?: unknown;
  delegationGuidance?: unknown;
}): Promise<string[]> {
  const errors: string[] = [];
  if (
    input.delegationGuidance !== undefined &&
    (typeof input.delegationGuidance !== "string" ||
      input.delegationGuidance.length > 1000)
  ) {
    errors.push("delegationGuidance must be a string (max 1000 chars)");
  }
  if (
    typeof input.name !== "string" ||
    input.name.trim().length === 0 ||
    input.name.length > 128
  ) {
    errors.push("name must be a non-empty string (max 128 chars)");
  } else if (slugifySubagentName(input.name).length === 0) {
    errors.push("name must contain at least one letter or digit");
  }
  if (
    typeof input.instructions !== "string" ||
    input.instructions.trim().length === 0
  ) {
    errors.push("instructions must be a non-empty string");
  } else if (input.instructions.length > 20_000) {
    errors.push("instructions must be at most 20000 characters");
  }
  if (
    !Array.isArray(input.tools) ||
    input.tools.length === 0 ||
    !input.tools.every((t) => typeof t === "string" && TOOL_KEY_SET.has(t))
  ) {
    errors.push(
      `tools must be a non-empty array from: ${[...TOOL_KEY_SET].join(", ")}`
    );
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    errors.push("enabled must be a boolean");
  }
  if (
    input.model !== undefined &&
    input.model !== "" &&
    (typeof input.model !== "string" || input.model.length > 256)
  ) {
    errors.push("model must be a string (max 256 chars) or empty");
  }
  if (input.maxSteps !== undefined) {
    if (
      typeof input.maxSteps !== "number" ||
      !Number.isFinite(input.maxSteps) ||
      input.maxSteps < MIN_STEPS ||
      input.maxSteps > MAX_STEPS_LIMIT
    ) {
      errors.push(`maxSteps must be a number between ${MIN_STEPS} and ${MAX_STEPS_LIMIT}`);
    }
  }
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 500)
  ) {
    errors.push("description must be a string (max 500 chars)");
  }
  if (typeof input.model === "string" && input.model.trim().length > 0) {
    const provider = await resolveProviderForModelRef(input.model.trim());
    if (provider?.kind === "web-session") {
      errors.push(
        `model "${input.model.trim()}" belongs to the experimental web provider "${provider.name}", which cannot run subagents — choose a model from an API provider.`
      );
    }
  }
  return errors;
}

/**
 * Resolves the registry provider a stored model ref points at. A bare id
 * belongs to the server provider, via the shared ref decoder the chat route
 * also uses. Returns null when the ref names no known provider — an unknown
 * ref is not a validation error here (the runner degrades it to the default
 * model), and an unreadable registry is left for the caller to report rather
 * than misclassified as a web-session ref.
 */
async function resolveProviderForModelRef(
  modelRef: string
): Promise<ProviderEntry | null> {
  const { providerId } = decodeModelRef(modelRef);
  try {
    return await getProviderById(providerId);
  } catch (error) {
    if (error instanceof ProviderConfigError) return null;
    throw error;
  }
}

/** Create a new subagent. Throws on validation failure or when full. */
export async function createSubagent(
  input: SubagentInput,
  db: AppDatabase = defaultDb
): Promise<SubagentConfig> {
  const errors = await validateSubagentInput(input);
  if (errors.length > 0) {
    throw new SubagentValidationError(errors);
  }

  // Resolve the id BEFORE the read-modify-write block: the dynamic
  // import("nanoid") used to sit between the read and the persist, yielding
  // the event loop so two concurrent creates could interleave and silently
  // drop one another's rows (lost update). With the id in hand the entire
  // check-and-persist sequence below is synchronous — atomic under Node's
  // single thread, same as updateSubagent/deleteSubagent.
  const { nanoid } = await import("nanoid");
  const id = `sub_${nanoid(10)}`;

  const existing = listSubagents(db);
  if (existing.length >= MAX_SUBAGENTS) {
    throw new SubagentValidationError([
      `Maximum of ${MAX_SUBAGENTS} subagents reached`,
    ]);
  }

  // Tool names must be unique so the delegation tools never collide.
  const slug = slugifySubagentName(input.name);
  if (existing.some((s) => slugifySubagentName(s.name) === slug)) {
    throw new SubagentValidationError([
      `A subagent named "${input.name.trim()}" already exists`,
    ]);
  }

  const now = new Date().toISOString();
  const subagent: SubagentConfig = {
    id,
    name: input.name.trim(),
    instructions: input.instructions.trim(),
    tools: input.tools,
    enabled: input.enabled ?? true,
    model: input.model?.trim() || undefined,
    maxSteps: input.maxSteps ?? 12,
    description: input.description?.trim() || undefined,
    delegationGuidance: input.delegationGuidance?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  persistSubagents([...existing, subagent], db);
  syslog(
    "info",
    "subagents",
    `Subagent created: "${subagent.name}" (tools: ${subagent.tools.join(", ")}, id ${subagent.id})`
  );
  return subagent;
}

/** Update an existing subagent by id; returns null when not found. */
export async function updateSubagent(
  id: SubagentId,
  patch: Partial<SubagentInput>,
  db: AppDatabase = defaultDb
): Promise<SubagentConfig | null> {
  const existing = listSubagents(db);
  const idx = existing.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  const current = existing[idx];
  const candidate = {
    name: patch.name ?? current.name,
    instructions: patch.instructions ?? current.instructions,
    tools: patch.tools ?? current.tools,
    enabled: patch.enabled ?? current.enabled,
    model: patch.model ?? current.model,
    maxSteps: patch.maxSteps ?? current.maxSteps,
    description: patch.description ?? current.description,
    delegationGuidance: patch.delegationGuidance ?? current.delegationGuidance,
  };

  const errors = await validateSubagentInput(candidate);
  if (errors.length > 0) {
    throw new SubagentValidationError(errors);
  }

  // Enforce name uniqueness on rename.
  const slug = slugifySubagentName(candidate.name);
  if (
    existing.some(
      (s) => s.id !== id && slugifySubagentName(s.name) === slug
    )
  ) {
    throw new SubagentValidationError([
      `A subagent named "${candidate.name}" already exists`,
    ]);
  }

  const updated: SubagentConfig = {
    ...current,
    name: candidate.name.trim(),
    instructions: candidate.instructions.trim(),
    tools: candidate.tools,
    enabled: candidate.enabled,
    model: candidate.model?.trim() || undefined,
    maxSteps: candidate.maxSteps,
    description: candidate.description?.trim() || undefined,
    delegationGuidance: candidate.delegationGuidance?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  existing[idx] = updated;
  persistSubagents(existing, db);
  syslog(
    "info",
    "subagents",
    `Subagent updated: "${updated.name}" (id ${updated.id})`
  );
  return updated;
}

/** Delete a subagent by id; returns the removed row or null. */
export function deleteSubagent(
  id: SubagentId,
  db: AppDatabase = defaultDb
): SubagentConfig | null {
  const existing = listSubagents(db);
  const idx = existing.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const [removed] = existing.splice(idx, 1);
  persistSubagents(existing, db);
  syslog("info", "subagents", `Subagent deleted: "${removed.name}" (id ${removed.id})`);
  return removed;
}

/**
 * Model resolution for a subagent: its override, else the chat default.
 * Kept for callers that need the RAW stored ref (e.g. the settings UI);
 * the runner decodes qualified "providerId::modelId" refs itself.
 */
export function resolveSubagentModelRef(
  config: SubagentConfig
): string | undefined {
  return config.model?.trim() || undefined;
}
