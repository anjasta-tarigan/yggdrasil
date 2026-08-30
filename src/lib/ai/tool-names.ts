/**
 * Tool-name constants shared across the tool registry, the subagent
 * layer and the MCP collision filter. Pure leaf module — no imports —
 * so every consumer can depend on it without cycles.
 *
 * This is the single source of truth for names that more than one
 * module needs to agree on (Rule 01 — SSoT).
 */

/** Sandbox workspace tool names (built per request by createSandboxTools). */
export const SANDBOX_TOOL_NAMES = ["bash", "readFile", "writeFile"] as const;

/** Prefix for every generated subagent delegation tool name. */
export const DELEGATE_TOOL_PREFIX = "delegate_";
