/**
 * Tool-name constants shared across the tool registry, the subagent
 * layer and the MCP collision filter. Pure leaf module — no imports —
 * so every consumer can depend on it without cycles.
 *
 * This is the single source of truth for names that more than one
 * module needs to agree on (Rule 01 — SSoT).
 */

/**
 * Sandbox workspace tool names.
 *
 * Must match the keys `createSandboxTools()` returns (lib/sandbox/host-sandbox.ts):
 * the bash tool plus its `shell`/`exec` aliases, and the two file tools. A name
 * missing here is treated as "not a sandbox tool" by the MCP collision filter
 * and as "unknown" by the tool-toggle store, so it drifts silently.
 */
export const SANDBOX_TOOL_NAMES = [
  "bash",
  "shell",
  "exec",
  "readFile",
  "writeFile",
] as const;

/** Prefix for every generated subagent delegation tool name. */
export const DELEGATE_TOOL_PREFIX = "delegate_";
