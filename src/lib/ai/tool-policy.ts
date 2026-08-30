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

const DANGEROUS_TOOL_VERB_REGEX = /(?:^|_)(delete|drop|destroy)(?:_|$)/i;

/**
 * Evaluates whether a tool call requires user confirmation before execution.
 *
 * @param toolName Name of the tool being called (e.g. 'bash', 'delete_skill', 'mcp_postgres_drop_table')
 * @param input The raw input payload provided to the tool
 * @returns Promise<"user-approval" | undefined>
 */
export async function evaluateToolApproval(
  toolName: string,
  input: unknown
): Promise<"user-approval" | undefined> {
  if (!toolName) return undefined;

  // 1. Skill management mutations
  if (toolName === "delete_skill" || toolName === "update_skill") {
    return "user-approval";
  }

  // 2. Bash / Sandbox commands
  if (toolName === "bash" || toolName === "projectBash") {
    if (typeof input === "object" && input !== null) {
      const command = (input as { command?: unknown }).command;
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

  // 3. Dangerous MCP tools or external tools with destructive verbs.
  // memory_note_delete is the known built-in that legitimately contains the
  // verb: it removes one expiring working-memory note, not durable data.
  if (toolName !== "memory_note_delete" && DANGEROUS_TOOL_VERB_REGEX.test(toolName)) {
    return "user-approval";
  }

  return undefined;
}
