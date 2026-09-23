/**
 * Tool execution approval policy engine.
 *
 * Evaluates requested tool invocations against safety invariants to determine
 * if human confirmation is required before execution ("user-approval").
 */

const DESTRUCTIVE_BASH_PATTERNS = [
  // Recursive deletions: rm -rf, rm -r, rm -fr, rm --recursive, etc.
  /\brm\s+-[a-zA-Z0-9]*r/i,
  /\brm\s+--recursive\b/i,

  // Package installations
  /\b(npm\s+(i|install)|pnpm\s+(add|i|install)|yarn\s+add|bun\s+add|pip3?\s+install|cargo\s+add)\b/i,

  // Process termination signals
  /\b(kill|killall|pkill)\b/i,

  // Dangerous git operations
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+push\b.*(\s+-f\b|\s+--force\b)/i,
  // git clean: -f alone or in a combined short-flag cluster (-fd, -fdx…),
  // plus the --force long form.
  /\bgit\s+clean\b.*(\s+-f\d*\b|\s+-[a-z]*f[a-z]*\b|\s+--force\b)/i,
];

const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  "delete",
  "drop",
  "destroy",
]);

/**
 * Does the tool name contain a destructive verb as a whole word?
 *
 * A regex over the raw name is not enough: it must match `postgres__dropTable`
 * and `someTool-delete-all` (which a separator-only pattern misses) while NOT
 * matching `dropdown_menu` or `dropzone` (where "drop" is a substring, not the
 * verb). So split into words first — on separators and on camelCase
 * boundaries — then compare whole words.
 *
 * The camelCase split looks behind for a lowercase/digit, so an all-caps run
 * (`DELETE_ALL`) stays one word instead of shattering into single letters.
 */
function hasDestructiveVerb(toolName: string): boolean {
  return toolName
    .split(/[_\-.]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .some((word) => DESTRUCTIVE_VERBS.has(word.toLowerCase()));
}

/**
 * Tool names that carry a destructive verb but are intentionally exempt: the
 * verb describes removing one ephemeral item, not durable data. Keep this list
 * explicit and justified — an unlisted name is gated.
 */
const DESTRUCTIVE_VERB_EXEMPTIONS: ReadonlySet<string> = new Set([
  // Removes one expiring working-memory note, not durable memory.
  "memory_note_delete",
]);

/**
 * Tools that write to the filesystem and must pause for confirmation on their
 * mutating actions. `read`/`list`/`find`/`grep` are read-only and stay free.
 */
const FILE_MUTATING_ACTIONS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "delete",
]);

/**
 * Tools that create a persisted capability which executes on later calls.
 * Creating one is gated even though the action is nominally "create" — unlike
 * a cron schedule or a subagent, the artefact itself runs later without the
 * policy seeing it:
 *  - manage_mcp_server: persists a command that is spawned on connect.
 *  - manage_custom_tool: persists a tool that executes on every later call
 *    (currently an HTTP request; the schema also declares a `javascript`
 *    execution type for which no executor exists yet).
 */
const EXECUTION_CAPABILITY_TOOLS: ReadonlySet<string> = new Set([
  "manage_mcp_server",
  "manage_custom_tool",
]);

/**
 * Evaluates whether a tool call requires user confirmation before execution.
 *
 * @param toolName Name of the tool being called (e.g. 'bash', 'mcp_postgres_drop_table')
 * @param input The raw input payload provided to the tool
 * @returns Promise<"user-approval" | undefined>
 */
export async function evaluateToolApproval(
  toolName: string,
  input: unknown
): Promise<"user-approval" | undefined> {
  if (!toolName) return undefined;

  // 1. Bash / Sandbox commands
  if (
    toolName === "bash" ||
    toolName === "projectBash" ||
    toolName === "shell" ||
    toolName === "exec"
  ) {
    if (typeof input === "object" && input !== null) {
      const inputObj = input as { command?: unknown; cmd?: unknown };
      const command = inputObj.command ?? inputObj.cmd;
      if (typeof command === "string") {
        for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
          if (pattern.test(command)) {
            return "user-approval";
          }
        }
      }
    }
    return undefined;
  }

  // 2. Filesystem writes.
  //    file_operations carries write/edit/delete actions. The read-only
  //    actions (list/find/grep/jump/read) stay free; anything that mutates the
  //    workspace pauses for confirmation. This matters most for the project
  //    harness, whose approval predicate already routes file_operations
  //    through this engine (src/lib/project-harness-approval.ts) — before this
  //    rule existed, that predicate was a silent no-op.
  if (toolName === "file_operations" && typeof input === "object" && input !== null) {
    const action = (input as { action?: unknown }).action;
    if (typeof action === "string" && FILE_MUTATING_ACTIONS.has(action)) {
      return "user-approval";
    }
    return undefined;
  }

  // 3. Dangerous MCP tools or external tools with destructive verbs.
  //    Exemptions are explicit: a name carrying a destructive verb that is
  //    genuinely benign must be listed in DESTRUCTIVE_VERB_EXEMPTIONS with a
  //    reason, so the default for an unknown name is to gate.
  if (!DESTRUCTIVE_VERB_EXEMPTIONS.has(toolName) && hasDestructiveVerb(toolName)) {
    return "user-approval";
  }

  // 4. Management tool destructive actions — require user confirmation.
  //    These wrap system service-layer CRUD (cron, subagents, MCP servers).
  //    "update" and "delete" can modify or remove running infrastructure, so
  //    they pause for approval.
  //
  //    "create" is normally additive and reversible (a cron schedule, a
  //    subagent) and stays auto-approved. The exception is a create whose
  //    product is a persisted execution capability — see
  //    EXECUTION_CAPABILITY_TOOLS.
  const MANAGEMENT_TOOLS = [
    "manage_cron_schedule",
    "manage_mcp_server",
    "manage_subagent",
  ];
  if (
    MANAGEMENT_TOOLS.includes(toolName) &&
    typeof input === "object" &&
    input !== null
  ) {
    const action = (input as { action?: unknown }).action;
    if (action === "update" || action === "delete") {
      return "user-approval";
    }
    if (action === "create" && EXECUTION_CAPABILITY_TOOLS.has(toolName)) {
      return "user-approval";
    }
  }

  // 5. Custom tool management policy:
  //    Deleting a tool, disabling an active one, or authoring a new one (which
  //    becomes executable on later calls) requires user approval.
  if (
    toolName === "manage_custom_tool" &&
    typeof input === "object" &&
    input !== null
  ) {
    const { action, enabled } = input as { action?: unknown; enabled?: unknown };
    if (action === "delete" || action === "create") return "user-approval";
    if (action === "update" && enabled === false) {
      return "user-approval";
    }
  }

  return undefined;
}
