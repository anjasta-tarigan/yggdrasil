import { db as defaultDb, type AppDatabase } from "@/db";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { syslog } from "@/lib/observability/log-store";

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
 * NOTE: an "artifacts" (create_artifact) grant is NOT offered: artifacts
 * created inside a subagent land only in its nested UIMessage, which the
 * main chat's artifact chip scan does not recurse into — a granted-but-
 * invisible capability is worse than an unlisted one. Re-add the entry
 * together with nested-artifact rendering in SubagentInvocation.
 */
export type SubagentToolKey =
  | "web_search"
  | "fetch_page"
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
    key: "fetch_page",
    label: "Fetch Page",
    description: "Read a specific URL as markdown",
    toolNames: ["fetch_page"],
  },
  {
    key: "memory",
    label: "Memory",
    description: "Recall long-term memories and notes",
    toolNames: ["recall_memories", "remember_note"],
  },
  {
    key: "sandbox",
    label: "Sandbox",
    description: "bash / readFile / writeFile in the data/sandbox workspace",
    toolNames: ["bash", "readFile", "writeFile"],
  },
  {
    key: "tasks",
    label: "Task Checklist",
    description: "Visible plan/task checklist tool",
    toolNames: ["manage_tasks"],
  },
];

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

IMPORTANT: When you have finished, write a clear summary of your findings as your final response.
This summary will be returned to the main agent, so include all relevant information, cite sources where applicable, and keep it focused and dense.`,
    tools: ["web_search", "fetch_page", "memory"],
    enabled: true,
    maxSteps: 12,
    description:
      "Explores the web and long-term memory in depth, returns a focused summary",
    builtIn: true,
  },
  {
    name: "Coder",
    instructions: `You are a coding agent working inside a sandboxed workspace. Build, run, and test code with the shell and file tools. Iterate until the task works.

IMPORTANT: When you have finished, write a clear summary as your final response: what you built, the key files, how to run it, and any caveats. This summary will be returned to the main agent.`,
    tools: ["sandbox", "tasks"],
    enabled: true,
    maxSteps: 20,
    description:
      "Writes and executes code in the sandbox workspace, iterates until it works",
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
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

/** Read all subagents; seeds the built-ins on first access. */
export function listSubagents(db: AppDatabase = defaultDb): SubagentConfig[] {
  const stored = getSettingDb(SUBAGENTS_SETTINGS_KEY, db);
  if (stored === undefined) {
    return seedBuiltInSubagents(db);
  }
  if (!Array.isArray(stored)) return [];
  return stored.filter(isSubagentShape);
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
export function validateSubagentInput(input: {
  name?: unknown;
  instructions?: unknown;
  tools?: unknown;
  enabled?: unknown;
  model?: unknown;
  maxSteps?: unknown;
  description?: unknown;
}): string[] {
  const errors: string[] = [];
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
  return errors;
}

/** Create a new subagent. Throws on validation failure or when full. */
export async function createSubagent(
  input: SubagentInput,
  db: AppDatabase = defaultDb
): Promise<SubagentConfig> {
  const errors = validateSubagentInput(input);
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
  };

  const errors = validateSubagentInput(candidate);
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
