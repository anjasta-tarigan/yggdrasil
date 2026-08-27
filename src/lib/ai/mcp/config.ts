/**
 * MCP (Model Context Protocol) server configuration types and validation.
 *
 * This module is pure (no server-only imports) so it can be shared between
 * the server-side MCP manager, the API routes and the browser settings
 * client. Configs are persisted in the SQLite settings store under the
 * "mcpServers" key.
 *
 * Transport kinds (AI SDK v7 `@ai-sdk/mcp`):
 *  - "http":  Streamable HTTP transport (recommended for remote servers)
 *  - "sse":   Server-Sent Events transport (legacy remote servers)
 *  - "stdio": spawns a local child process (local development only)
 */

export type McpTransportKind = "http" | "sse" | "stdio";

export type McpServerConfig = {
  /** Unique stable id (generated); used for baselines and status entries. */
  id: string;
  /** Display name; also slugified into the tool name prefix. */
  name: string;
  transport: McpTransportKind;
  /** Disabled servers are skipped when collecting tools for the chat. */
  enabled: boolean;
  /** http / sse only: endpoint URL. */
  url?: string;
  /** http / sse only: extra request headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** stdio only: executable to spawn. */
  command?: string;
  /** stdio only: argv for the spawned process. */
  args?: string[];
  /** stdio only: extra environment variables for the spawned process. */
  env?: Record<string, string>;
};

/** Settings-store key holding the McpServerConfig[] registry. */
export const MCP_SERVERS_KEY = "mcpServers";
/** Settings-store key holding approved tool fingerprints per server id. */
export const MCP_BASELINES_KEY = "mcpBaselines";
/** Settings-store key holding the last connection status per server id. */
export const MCP_STATUS_KEY = "mcpStatus";

export const MAX_MCP_SERVERS = 20;
export const MAX_MCP_HEADERS = 20;
export const MAX_MCP_ENV_VARS = 64;
export const MAX_MCP_ARGS = 64;

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_COMMAND_LENGTH = 1024;
const MAX_ARG_LENGTH = 1024;

/** HTTP token characters (RFC 9110) — used to validate header names. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Environment variable identifiers. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createMcpServerId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

function isBoundedString(
  value: unknown,
  maxLength: number
): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/**
 * Validate and normalize one MCP server config. Returns a clean copy with
 * only the fields valid for its transport, or null when the shape is
 * invalid. Used by the API route sanitizer and the browser hydration guard.
 */
export function sanitizeMcpServerConfig(value: unknown): McpServerConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;

  if (!isBoundedString(v.id, MAX_ID_LENGTH)) return null;
  if (!isBoundedString(v.name, MAX_NAME_LENGTH)) return null;
  const trimmedName = v.name.trim();
  if (trimmedName.length === 0) return null;
  if (v.transport !== "http" && v.transport !== "sse" && v.transport !== "stdio") {
    return null;
  }
  const enabled = v.enabled === undefined ? true : v.enabled === true;

  const clean: McpServerConfig = {
    id: v.id,
    name: trimmedName,
    transport: v.transport,
    enabled,
  };

  if (v.transport === "http" || v.transport === "sse") {
    if (
      typeof v.url !== "string" ||
      v.url.length === 0 ||
      v.url.length > MAX_URL_LENGTH ||
      !/^https?:\/\//.test(v.url)
    ) {
      return null;
    }
    clean.url = v.url;

    if (v.headers !== undefined) {
      if (typeof v.headers !== "object" || v.headers === null || Array.isArray(v.headers)) {
        return null;
      }
      const entries = Object.entries(v.headers as Record<string, unknown>);
      if (entries.length > MAX_MCP_HEADERS) return null;
      const headers: Record<string, string> = {};
      for (const [key, headerValue] of entries) {
        if (
          !isBoundedString(key, MAX_HEADER_NAME_LENGTH) ||
          !HEADER_NAME_RE.test(key) ||
          typeof headerValue !== "string" ||
          headerValue.length > MAX_HEADER_VALUE_LENGTH
        ) {
          return null;
        }
        headers[key] = headerValue;
      }
      if (entries.length > 0) clean.headers = headers;
    }
    return clean;
  }

  // stdio transport
  if (!isBoundedString(v.command, MAX_COMMAND_LENGTH)) return null;
  if (/[\x00-\x1f]/.test(v.command)) return null;
  clean.command = v.command;

  if (v.args !== undefined) {
    if (!Array.isArray(v.args) || v.args.length > MAX_MCP_ARGS) return null;
    const args: string[] = [];
    for (const arg of v.args) {
      if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH) return null;
      args.push(arg);
    }
    if (args.length > 0) clean.args = args;
  }

  if (v.env !== undefined) {
    if (typeof v.env !== "object" || v.env === null || Array.isArray(v.env)) {
      return null;
    }
    const entries = Object.entries(v.env as Record<string, unknown>);
    if (entries.length > MAX_MCP_ENV_VARS) return null;
    const env: Record<string, string> = {};
    for (const [key, envValue] of entries) {
      if (
        !ENV_KEY_RE.test(key) ||
        typeof envValue !== "string" ||
        envValue.length > MAX_HEADER_VALUE_LENGTH
      ) {
        return null;
      }
      env[key] = envValue;
    }
    if (entries.length > 0) clean.env = env;
  }

  return clean;
}

/**
 * Validate a whole server list (the "mcpServers" settings payload or the
 * stored value). Returns the sanitized list, or null when anything is
 * invalid so callers can reject the payload outright.
 */
export function sanitizeMcpServerList(value: unknown): McpServerConfig[] | null {
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) return null;
  const servers: McpServerConfig[] = [];
  const seenIds = new Set<string>();
  for (const entry of value) {
    const clean = sanitizeMcpServerConfig(entry);
    if (!clean || seenIds.has(clean.id)) return null;
    seenIds.add(clean.id);
    servers.push(clean);
  }
  return servers;
}

/**
 * Turn a server display name into a stable tool-name prefix slug
 * (lowercase alphanumerics and hyphens). Falls back to "server" when the
 * name has no usable characters.
 */
export function slugifyServerName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "server";
}
