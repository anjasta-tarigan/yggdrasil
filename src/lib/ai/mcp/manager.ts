import {
  createMCPClient,
  type MCPClient,
  type MCPTransport,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { detectToolDrift, fingerprintTools, type ToolSet } from "ai";
import type { AppDatabase } from "@/db";
import { builtinTools } from "@/lib/ai/tools/index";
import {
  DELEGATE_TOOL_PREFIX,
  SANDBOX_TOOL_NAMES,
} from "@/lib/ai/tool-names";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import {
  MCP_BASELINES_KEY,
  MCP_SERVERS_KEY,
  MCP_STATUS_KEY,
  sanitizeMcpServerConfig,
  slugifyServerName,
  type McpServerConfig,
} from "./config";

/**
 * Server-side MCP manager (AI SDK v7).
 *
 * Responsibilities:
 *  - Connect to every enabled configured MCP server (http / sse / stdio)
 *    with bounded timeouts, in parallel.
 *  - Convert server tools to AI SDK tools, prefixed with a per-server slug
 *    so tools from different servers (and built-in tools) never collide.
 *  - Detect tool-definition drift ("rug pull") against approved baselines
 *    using `fingerprintTools` / `detectToolDrift`: changed tools and newly
 *    added tools are withheld from the model until the user re-approves
 *    the server on the MCP page.
 *  - Persist baselines, per-server runtime status and drift reports in the
 *    SQLite settings store so the MCP page can display them.
 *
 * Clients are short-lived: `collectMcpTools` opens them for one chat
 * request and the caller closes them via the returned `close()` once the
 * response stream finishes (per the AI SDK MCP docs).
 */

/** Bound for transport startup + initialize handshake. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
/** Bound for tool listing after a successful connection. */
export const MCP_TOOLS_TIMEOUT_MS = 15_000;

const CLIENT_NAME = "yggdrasil";
const CLIENT_VERSION = "0.1.0";

/**
 * Tool-name prefixes reserved for locally generated tools: the delegation
 * tools built per enabled subagent. A remote server tool whose underlying
 * name starts with one of these is withheld.
 */
const PROTECTED_TOOL_PREFIXES: readonly string[] = [DELEGATE_TOOL_PREFIX];

/** Why a server tool's name is reserved by a local tool. */
export type WithheldReason =
  | { kind: "builtin"; tool: string }
  | { kind: "sandbox"; tool: string }
  | { kind: "delegation"; tool: string };

/** Human-readable reason for one withheld tool. */
function describeWithheld(entry: WithheldReason): string {
  switch (entry.kind) {
    case "builtin":
      return `duplicates the built-in "${entry.tool}" tool; built-ins take precedence`;
    case "sandbox":
      return `duplicates the sandbox "${entry.tool}" tool; sandbox tools take precedence`;
    case "delegation":
      return `starts with the reserved "${DELEGATE_TOOL_PREFIX}" prefix used by subagent delegation tools`;
  }
}

/** Why a server tool's name is reserved, or undefined when it is not. */
function protectedToolReason(name: string): WithheldReason | undefined {
  if (name in builtinTools) return { kind: "builtin", tool: name };
  if (SANDBOX_TOOL_NAMES.includes(name as (typeof SANDBOX_TOOL_NAMES)[number]))
    return { kind: "sandbox", tool: name };
  if (PROTECTED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)))
    return { kind: "delegation", tool: name };
  return undefined;
}

/**
 * The adapted tool map returned by `MCPClient.tools()`. Kept as its own
 * alias because the MCP tool union (`McpToolBase<unknown, CallToolResult>`)
 * does not literally satisfy the `ToolSet` index signature in TypeScript's
 * variance check, even though the SDK passes these tools straight into
 * `streamText`/`generateText` at runtime.
 */
export type McpToolBag = Awaited<ReturnType<MCPClient["tools"]>>;

/**
 * Fingerprint an MCP tool bag. `fingerprintTools` only reads each tool's
 * description, resolved input schema and title, so the cast across the
 * ToolSet variance gap is safe.
 */
function fingerprintMcpTools(tools: McpToolBag): Promise<Record<string, string>> {
  return fingerprintTools(tools as unknown as ToolSet);
}

/** Approved tool fingerprints per server id. */
export type McpBaselines = Record<
  string,
  { fingerprints: Record<string, string>; updatedAt: string }
>;

/** Last known connection outcome per server id (shown on the MCP page). */
export type McpServerRuntimeStatus = {
  ok: boolean;
  /** Connection/tool error message when ok is false. */
  error?: string;
  /** Number of tools exposed to the model after drift filtering. */
  toolCount?: number;
  /** Server-reported implementation name, when the connection succeeded. */
  serverName?: string;
  protocolVersion?: string;
  /** Tools withheld from the model until re-approval. */
  drift?: { changed: string[]; added: string[] };
  /**
   * Tools withheld because their underlying name duplicates a built-in
   * (or sandbox) tool. Built-ins take precedence: a remote server must
   * not shadow a core capability. Mirrors the MCP spec's
   * reject-with-warning pattern — never a silent drop.
   */
  withheld?: Array<{ tool: string; reason: string }>;
  lastAttemptAt: string;
};

export type McpStatusMap = Record<string, McpServerRuntimeStatus>;

/** Per-server outcome of one collection pass. */
export type McpCollectionStatus = {
  serverId: string;
  name: string;
  ok: boolean;
  error?: string;
  toolCount: number;
  drift?: { changed: string[]; added: string[] };
  withheld?: Array<{ tool: string; reason: string }>;
};

export type McpToolCollection = {
  /** Merged, prefixed tools ready to spread into streamText's `tools`. */
  tools: McpToolBag;
  /**
   * Formatted server-provided instructions block for the system prompt
   * (empty string when no connected server provided instructions).
   */
  instructions: string;
  /** Close every opened client. Safe to call more than once. */
  close: () => Promise<void>;
  statuses: McpCollectionStatus[];
};

/** Override for tests: connect a config to a client without real I/O. */
export type McpConnectFn = (config: McpServerConfig) => Promise<MCPClient>;

// ---- Settings-store accessors --------------------------------------------

export function getMcpServerConfigs(db?: AppDatabase): McpServerConfig[] {
  const raw = getSettingDb(MCP_SERVERS_KEY, db);
  if (!Array.isArray(raw)) return [];
  const servers: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    // Re-validate on read: a hand-edited database must not inject shapes
    // the transport factory cannot handle.
    const clean = sanitizeMcpServerConfig(entry);
    if (clean && !seen.has(clean.id)) {
      seen.add(clean.id);
      servers.push(clean);
    }
  }
  return servers;
}

export function getMcpBaselines(db?: AppDatabase): McpBaselines {
  const raw = getSettingDb(MCP_BASELINES_KEY, db);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as McpBaselines;
}

export function getMcpStatusMap(db?: AppDatabase): McpStatusMap {
  const raw = getSettingDb(MCP_STATUS_KEY, db);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as McpStatusMap;
}

// ---- Transports and connections ------------------------------------------

/**
 * Build the transport for a server config: the declarative http/sse
 * config object, or an explicit stdio transport instance for local
 * command servers.
 */
export function createMcpTransport(
  config: McpServerConfig
): Parameters<typeof createMCPClient>[0]["transport"] {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new Error(`MCP server "${config.name}" has no stdio command`);
    }
    return new Experimental_StdioMCPTransport({
      command: config.command,
      args: config.args,
      env: config.env,
    });
  }
  if (!config.url) {
    throw new Error(`MCP server "${config.name}" has no URL`);
  }
  return {
    type: config.transport,
    url: config.url,
    headers: config.headers,
    // Keep the v7 default ('error'): servers must not redirect us to
    // other hosts (SSRF protection).
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Open one MCP client for a server config with a bounded handshake.
 * Throws (after closing the transport) when the connection fails.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  options?: { connectTimeoutMs?: number }
): Promise<MCPClient> {
  const transport = createMcpTransport(config);
  try {
    return await withTimeout(
      createMCPClient({
        transport,
        clientName: CLIENT_NAME,
        version: CLIENT_VERSION,
        protocolVersionDiscovery: false,
        initializationOptions: {
          timeout: options?.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
        },
        onUncaughtError: (error) => {
          console.warn(`[mcp] Uncaught error on "${config.name}":`, error);
        },
      }),
      options?.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
      `MCP connect to "${config.name}"`
    );
  } catch (error) {
    // createMCPClient may have started the transport (e.g. spawned a
    // process) before failing — best-effort cleanup.
    if (typeof (transport as MCPTransport)?.close === "function") {
      try {
        await (transport as MCPTransport).close();
      } catch {
        /* already closed */
      }
    }
    throw error;
  }
}

// ---- Drift / baselines ----------------------------------------------------

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Apply the drift policy to one server's tools.
 *
 *  - First sighting (no baseline): trust-on-first-use — the fingerprint
 *    becomes the approved baseline and all tools are allowed.
 *  - Later sightings: tools whose description/input schema/title changed,
 *    and tools that newly appeared, are removed from the set and reported
 *    as drift. The baseline is NOT updated automatically; the user
 *    re-approves from the MCP page (refreshMcpBaseline).
 *
 * Returns the filtered tool set plus the drift report.
 */
async function applyDriftPolicy(
  serverId: string,
  tools: McpToolBag,
  baselines: McpBaselines
): Promise<{ tools: McpToolBag; drift?: { changed: string[]; added: string[] } }> {
  let fingerprints: Record<string, string>;
  try {
    fingerprints = await fingerprintMcpTools(tools);
  } catch (error) {
    // Fingerprinting is a pure digest; if it ever fails, allow the tools
    // rather than breaking the chat, and skip drift detection this pass.
    console.warn("[mcp] fingerprintTools failed; skipping drift check:", error);
    return { tools };
  }

  const baseline = baselines[serverId];
  if (!baseline || typeof baseline.fingerprints !== "object" || baseline.fingerprints === null) {
    baselines[serverId] = {
      fingerprints,
      updatedAt: new Date().toISOString(),
    };
    return { tools };
  }

  const { changed, added } = detectToolDrift(fingerprints, baseline.fingerprints);
  if (changed.length === 0 && added.length === 0) {
    return { tools };
  }

  const blocked = new Set([...changed, ...added]);
  const filtered: McpToolBag = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!blocked.has(name)) filtered[name] = tool;
  }
  return { tools: filtered, drift: { changed, added } };
}

/**
 * Re-approve a server's current tool definitions: reconnect, fingerprint
 * and store the new baseline, and clear any recorded drift. Used by the
 * MCP page "Approve" action after a drift report.
 */
export async function refreshMcpBaseline(
  serverId: string,
  db?: AppDatabase,
  connect?: McpConnectFn
): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
  const config = getMcpServerConfigs(db).find((s) => s.id === serverId);
  if (!config) return { ok: false, error: "Unknown MCP server id" };

  const doConnect = connect ?? ((c) => connectMcpServer(c));
  let client: MCPClient | undefined;
  try {
    client = await doConnect(config);
    const tools = await withTimeout(
      client.tools(),
      MCP_TOOLS_TIMEOUT_MS,
      `MCP tool listing for "${config.name}"`
    );
    const fingerprints = await fingerprintMcpTools(tools);

    const baselines = getMcpBaselines(db);
    baselines[serverId] = {
      fingerprints,
      updatedAt: new Date().toISOString(),
    };
    setSettingsDb({ [MCP_BASELINES_KEY]: baselines }, db);

    const status = getMcpStatusMap(db);
    // Replaces any previous drift report — this re-approval resolves it.
    status[serverId] = {
      ok: true,
      toolCount: Object.keys(tools).length,
      serverName: client.serverInfo?.name,
      protocolVersion: client.initializeResult?.protocolVersion,
      lastAttemptAt: new Date().toISOString(),
    };
    setSettingsDb({ [MCP_STATUS_KEY]: status }, db);

    return { ok: true, toolCount: Object.keys(tools).length };
  } catch (error) {
    const message = describeError(error);
    const status = getMcpStatusMap(db);
    status[serverId] = {
      ok: false,
      error: message,
      lastAttemptAt: new Date().toISOString(),
    };
    setSettingsDb({ [MCP_STATUS_KEY]: status }, db);
    return { ok: false, error: message };
  } finally {
    try {
      await client?.close();
    } catch {
      /* already closed */
    }
  }
}

// ---- Tool collection for the chat ----------------------------------------

/**
 * Connect every enabled MCP server, collect their tools (drift-filtered
 * and slug-prefixed) and aggregate server instructions for the system
 * prompt. Individual server failures never reject the whole collection —
 * they are recorded in the returned statuses and the settings store.
 */
export async function collectMcpTools(
  options?: { db?: AppDatabase; connect?: McpConnectFn }
): Promise<McpToolCollection> {
  const db = options?.db;
  const connect = options?.connect ?? ((config) => connectMcpServer(config));
  const servers = getMcpServerConfigs(db).filter((s) => s.enabled);

  const baselines = getMcpBaselines(db);
  const previousStatus = getMcpStatusMap(db);
  const clients: MCPClient[] = [];
  const statuses: McpCollectionStatus[] = [];
  const tools: McpToolBag = {};
  const instructionBlocks: string[] = [];
  const usedSlugs = new Set<string>();

  const results = await Promise.allSettled(
    servers.map(async (config) => {
      const client = await connect(config);
      try {
        const serverTools = await withTimeout(
          client.tools(),
          MCP_TOOLS_TIMEOUT_MS,
          `MCP tool listing for "${config.name}"`
        );
        const { tools: allowed, drift } = await applyDriftPolicy(
          config.id,
          serverTools,
          baselines
        );

        // Unique per-server slug → "slug__toolName" keys.
        let slug = slugifyServerName(config.name);
        if (usedSlugs.has(slug)) {
          let n = 2;
          while (usedSlugs.has(`${slug}-${n}`)) n += 1;
          slug = `${slug}-${n}`;
        }
        usedSlugs.add(slug);

        // Built-in precedence: withhold server tools whose underlying name
        // duplicates a local tool, recording each in the status (spec's
        // reject-with-warning pattern — never a silent drop).
        let count = 0;
        const withheld: Array<{ tool: string; reason: string }> = [];
        for (const [toolName, tool] of Object.entries(allowed)) {
          const why = protectedToolReason(toolName);
          if (why) {
            withheld.push({
              tool: toolName,
              reason: describeWithheld(why),
            });
            console.warn(
              `[mcp] Withholding "${config.name}" tool "${toolName}": ${why.kind} collision`
            );
            continue;
          }
          tools[`${slug}__${toolName}`] = tool;
          count += 1;
        }

        // Only inject server instructions when the server actually
        // contributed tools: a directive like "use web_search first"
        // must not steer the model at a tool that was withheld.
        if (client.instructions && count > 0) {
          instructionBlocks.push(
            `<mcp_server name="${config.name}">\n${client.instructions}\n</mcp_server>`
          );
        }

        clients.push(client);
        return {
          serverId: config.id,
          status: {
            ok: true,
            toolCount: count,
            serverName: client.serverInfo?.name,
            protocolVersion: client.initializeResult?.protocolVersion,
            ...(drift ? { drift } : {}),
            ...(withheld.length > 0 ? { withheld } : {}),
            lastAttemptAt: new Date().toISOString(),
          } satisfies McpServerRuntimeStatus,
          collection: {
            serverId: config.id,
            name: config.name,
            ok: true,
            toolCount: count,
            ...(drift ? { drift } : {}),
            ...(withheld.length > 0 ? { withheld } : {}),
          } satisfies McpCollectionStatus,
        };
      } catch (error) {
        try {
          await client.close();
        } catch {
          /* already closed */
        }
        throw error;
      }
    })
  );

  const statusMap: McpStatusMap = {};
  // Keep last-known statuses for servers that exist but were skipped
  // (disabled) this pass.
  for (const config of getMcpServerConfigs(db)) {
    const previous = previousStatus[config.id];
    if (previous) statusMap[config.id] = previous;
  }

  results.forEach((result, index) => {
    const config = servers[index];
    if (result.status === "fulfilled") {
      statusMap[config.id] = result.value.status;
      statuses.push(result.value.collection);
    } else {
      const error = describeError(result.reason);
      console.warn(`[mcp] Server "${config.name}" unavailable: ${error}`);
      statusMap[config.id] = {
        ok: false,
        error,
        lastAttemptAt: new Date().toISOString(),
      };
      statuses.push({
        serverId: config.id,
        name: config.name,
        ok: false,
        error,
        toolCount: 0,
      });
    }
  });

  // Persist baselines (may include new TOFU entries) and statuses.
  try {
    setSettingsDb(
      { [MCP_BASELINES_KEY]: baselines, [MCP_STATUS_KEY]: statusMap },
      db
    );
  } catch (error) {
    console.warn("[mcp] Failed to persist baselines/status:", error);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(
      clients.map(async (client) => {
        try {
          await client.close();
        } catch (error) {
          console.warn("[mcp] Error closing MCP client:", error);
        }
      })
    );
  };

  const instructions =
    instructionBlocks.length > 0
      ? `# MCP Server Instructions\nThe following instructions were provided by connected MCP servers:\n\n${instructionBlocks.join("\n\n")}`
      : "";

  return { tools, instructions, close, statuses };
}

// ---- Connection testing (Settings UI) -------------------------------------

export type McpTestResult = {
  ok: boolean;
  error?: string;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  instructions?: string;
  tools?: Array<{ name: string; description?: string }>;
};

/**
 * Connect to one server, list its tools and disconnect. Used by the
 * Settings "Test" action; never writes baselines or statuses.
 */
export async function testMcpServerConnection(
  config: McpServerConfig,
  connect?: McpConnectFn
): Promise<McpTestResult> {
  const doConnect = connect ?? ((c) => connectMcpServer(c));
  let client: MCPClient | undefined;
  try {
    client = await doConnect(config);
    const listing = await withTimeout(
      client.listTools(),
      MCP_TOOLS_TIMEOUT_MS,
      `MCP tool listing for "${config.name}"`
    );
    return {
      ok: true,
      serverName: client.serverInfo?.name,
      serverVersion: client.serverInfo?.version,
      protocolVersion: client.initializeResult?.protocolVersion,
      instructions: client.instructions,
      tools: (listing.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
      })),
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  } finally {
    try {
      await client?.close();
    } catch {
      /* already closed */
    }
  }
}
