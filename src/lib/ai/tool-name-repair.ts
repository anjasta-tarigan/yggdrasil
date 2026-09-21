/**
 * Deterministic repair of hallucinated tool names.
 *
 * Models occasionally call tools by aliases ('read', 'write', 'shell', …)
 * that do not exist in the harness tool set. The AI SDK surfaces these as
 * NoSuchToolError. This module maps known aliases to their canonical names
 * and, for file aliases, injects the correct `action` field if the model
 * didn't supply one — without overwriting an action the model already sent.
 *
 * Rules (from spec):
 *  - Normalize: trim, lowercase, treat - / _ / space as equivalent.
 *  - File aliases map to `file_operations`; shell aliases map to `bash`.
 *  - The target tool MUST exist in availableToolNames; otherwise return null.
 *  - Never invent parameters; never overwrite a model-supplied `action`.
 *  - input must be valid JSON and a plain object; otherwise return null.
 */

/** Minimal shape of a provider tool call relevant to name repair. */
type ToolCallLike = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** Stringified JSON object with tool arguments. */
  input: string;
};

/** Normalize a tool name for alias lookup: trim, lowercase, unify separators. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[-_\s]+/g, "_");
}

/**
 * File-operation aliases: maps a normalized alias to the default `action`
 * value for `file_operations`. A model-supplied `action` is always preserved.
 */
const FILE_ALIASES: ReadonlyMap<string, string> = new Map([
  ["read",         "read"],
  ["read_file",    "read"],
  ["cat",          "read"],
  ["view",         "read"],
  ["write",        "write"],
  ["write_file",   "write"],
  ["create_file",  "write"],
  ["edit",         "edit"],
  ["str_replace",  "edit"],
  ["replace",      "edit"],
  ["edit_file",    "edit"],
  ["patch",        "edit"],
  ["ls",           "list"],
  ["list",         "list"],
  ["list_dir",     "list"],
  ["list_files",   "list"],
  ["listdir",      "list"],
  ["grep",         "grep"],
  ["search",       "grep"],
  ["search_files", "grep"],
  ["find",         "find"],
  ["glob",         "find"],
  ["find_files",   "find"],
]);

/** Shell aliases: normalized alias → canonical tool name `bash`. */
const SHELL_ALIASES: ReadonlySet<string> = new Set([
  "shell",
  "run",
  "run_command",
  "execute",
  "terminal",
  "exec",
]);

/**
 * Given a tool call whose name is unknown and the set of tool names actually
 * available in the harness, attempt to map it to a canonical tool.
 *
 * Returns a corrected `ToolCallLike` (same `toolCallId`, corrected `toolName`
 * and `input`) or `null` when no mapping applies or the target tool is not in
 * `availableToolNames`.
 */
export function repairToolCallByName(
  toolCall: ToolCallLike,
  availableToolNames: readonly string[]
): ToolCallLike | null {
  // Parse and validate the input — must be a plain JSON object.
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.input);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  const inputObj = parsed as Record<string, unknown>;

  const normed = normalize(toolCall.toolName);

  // ── File aliases ────────────────────────────────────────────────────────
  const defaultAction = FILE_ALIASES.get(normed);
  if (defaultAction !== undefined) {
    if (!availableToolNames.includes("file_operations")) return null;
    // Inject `action` only when the model didn't supply one.
    const repairedInput: Record<string, unknown> = {
      ...inputObj,
      action: inputObj["action"] ?? defaultAction,
    };
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: "file_operations",
      input: JSON.stringify(repairedInput),
    };
  }

  // ── Shell aliases ───────────────────────────────────────────────────────
  if (SHELL_ALIASES.has(normed)) {
    if (!availableToolNames.includes("bash")) return null;
    // Keep input unchanged; it must already carry `command`.
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: "bash",
      input: toolCall.input,
    };
  }

  return null;
}
