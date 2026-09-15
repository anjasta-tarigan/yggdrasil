import {
  createMCPClient,
  mcpAppClientCapabilities,
  readMCPAppResource,
  splitMCPAppTools,
  type ListToolsResult,
  type MCPAppResource,
  type MCPAppResourceCSP,
  type MCPClient,
  type MCPTransport,
} from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { detectToolDrift, fingerprintTools, type ToolSet } from "ai";
import type { AppDatabase } from "@/db";
import { getDisabledTools } from "@/lib/ai/tool-toggles";
import { builtinTools } from "@/lib/ai/tools/index";
import {
  DELEGATE_TOOL_PREFIX,
  SANDBOX_TOOL_NAMES,
} from "@/lib/ai/tool-names";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import {
  MCP_BASELINES_KEY,
  MCP_CAPABILITY_NAMES,
  MCP_SERVERS_KEY,
  MCP_STATUS_KEY,
  sanitizeMcpServerConfig,
  slugifyServerName,
  type McpServerConfig,
} from "./config";
import { mcpClientPool } from "./pool";
import { resolveSecretsIntoConfig } from "./secrets";

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
 * Capability tool names that are never withheld from MCP servers. These tools
 * (web_search, web_fetch) are designated capability tools: they coexist with
 * their built-in counterparts under the slug prefix so the model can fall back
 * to the built-in within the same turn if the MCP variant fails.
 */
export const CAPABILITY_TOOL_NAMES = MCP_CAPABILITY_NAMES;

/**
 * Tool-name prefixes reserved for locally generated tools: the delegation
 * tools built per enabled subagent. A remote server tool whose underlying
 * name starts with one of these is withheld.
 */
const PROTECTED_TOOL_PREFIXES: readonly string[] = [DELEGATE_TOOL_PREFIX];

/** Why a server tool's name is reserved by a local tool. */
export type WithheldReason =
  | { kind: "builtin"; tool: string }
  | { kind: "builtin-disabled"; tool: string }
  | { kind: "sandbox"; tool: string }
  | { kind: "delegation"; tool: string };

/** Human-readable reason for one withheld tool. */
function describeWithheld(entry: WithheldReason): string {
  switch (entry.kind) {
    case "builtin":
      return `duplicates the built-in "${entry.tool}" tool; built-ins take precedence (exposable)`;
    case "builtin-disabled":
      // Unreachable for withholding today: a disabled built-in is no
      // conflict, so the duplicate flows. Kept for status-text accuracy
      // if the policy ever tightens.
      return `duplicates the built-in "${entry.tool}" tool`;
    case "sandbox":
      return `duplicates the sandbox "${entry.tool}" tool; sandbox tools take precedence`;
    case "delegation":
      return `starts with the reserved "${DELEGATE_TOOL_PREFIX}" prefix used by subagent delegation tools`;
  }
}

/**
 * Why a server tool's name is reserved, or undefined when it is not.
 *
 * A built-in collision is only a conflict while the built-in is actually
 * enabled: when the user disabled the built-in via the Tools tab, exposing
 * the server's namespaced duplicate restores the capability instead of
 * leaving the model with neither. Sandbox and delegation collisions are
 * never releasable.
 */
function protectedToolReason(
  name: string,
  options?: { disabledBuiltins?: ReadonlySet<string>; allowDuplicates?: readonly string[] }
): WithheldReason | undefined {
  // Capability tools (web_search, web_fetch) are never withheld: they
  // coexist with their built-in counterparts under the slug prefix so the
  // model can fall back to the built-in within the same turn if the MCP
  // variant fails.
  if (CAPABILITY_TOOL_NAMES.includes(name as (typeof CAPABILITY_TOOL_NAMES)[number])) {
    return undefined;
  }
  // Sandbox tools (bash, file system access, etc.) must always be detected
  // as sandbox collisions, NOT as builtin collisions, even when they happen
  // to also be registered in `builtinTools`. This preserves the correct
  // collision `kind` for withholding logic and status reporting downstream.
  if (SANDBOX_TOOL_NAMES.includes(name as (typeof SANDBOX_TOOL_NAMES)[number]))
    return { kind: "sandbox", tool: name };
  if (name in builtinTools) {
    const disabled = options?.disabledBuiltins?.has(name) ?? false;
    // No conflict when the built-in is off — flow through.
    if (disabled) return undefined;
    // Explicit user release — flow through.
    if (options?.allowDuplicates?.includes(name)) return undefined;
    return { kind: "builtin", tool: name };
  }
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
 * Info about an MCP App tool — one whose `_meta.ui.visibility` includes
 * `"app"` and whose `_meta.ui.resourceUri` is a `ui://` URI. The host
 * uses this to route read-resource / call-tool requests to the right
 * server and to look up the app's HTML resource for rendering.
 */
export type MCPAppInfo = {
  toolName: string;
  resourceUri: string;
  serverName: string;
  serverId: string;
};

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
  /**
   * Built-in-name duplicates the user explicitly released on this
   * server, now exposed under their slug prefix (e.g.
   * "parallel-search__web_search"). The model has both tools and
   * chooses per call.
   */
  exposedDuplicates?: string[];
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
  exposedDuplicates?: string[];
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
  /**
   * MCP Apps discovered on connected servers: tools whose `_meta.ui.visibility`
   * includes `"app"` and whose `ui://` resource URI is valid. Exposed to the
   * host so the React renderer can route read-resource and call-tool requests
   * to the correct server.
   */
  apps: MCPAppInfo[];
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
  // Overlay stored secrets onto stdio env maps and http/sse headers so
  // tokens written through the Settings UI actually reach spawned child
  // processes and remote endpoints. A secrets-read failure never fails
  // the connection — the inline config stands.
  let effectiveConfig = config;
  const needsSecretOverlay =
    (config.transport === "stdio" && Boolean(config.env)) ||
    ((config.transport === "http" || config.transport === "sse") &&
      Boolean(config.headers));
  if (needsSecretOverlay) {
    try {
      effectiveConfig = await resolveSecretsIntoConfig(config);
    } catch (error) {
      console.warn(
        `[mcp] Failed to resolve stored secrets for "${config.name}"; using inline config:`,
        error
      );
    }
  }
  const transport = createMcpTransport(effectiveConfig);
  try {
    return await withTimeout(
      createMCPClient({
        transport,
        clientName: CLIENT_NAME,
        version: CLIENT_VERSION,
        protocolVersionDiscovery: false,
        // Advertise MCP Apps support so servers surface ui:// resources and
        // _meta.ui visibility on their tool definitions.
        capabilities: mcpAppClientCapabilities,
        initializationOptions: {
          timeout: options?.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS,
        },
        // Retry transient tool-call failures (dropped sessions, 503s).
        // JSON-RPC application errors are never retried by the SDK.
        maxRetries: 2,
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
  let fromCache = false;
  const cached = mcpClientPool.getCachedFingerprints(serverId);
  if (cached) {
    fingerprints = cached;
    fromCache = true;
  } else {
    try {
      fingerprints = await fingerprintMcpTools(tools);
      mcpClientPool.setCachedFingerprints(serverId, fingerprints);
    } catch (error) {
      // Fingerprinting is a pure digest; if it ever fails, allow the tools
      // rather than breaking the chat, and skip drift detection this pass.
      console.warn("[mcp] fingerprintTools failed; skipping drift check:", error);
      return { tools };
    }
  }

  const baseline = baselines[serverId];
  if (!baseline || typeof baseline.fingerprints !== "object" || baseline.fingerprints === null) {
    if (!fromCache) {
      baselines[serverId] = {
        fingerprints,
        updatedAt: new Date().toISOString(),
      };
    }
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
 * Extract MCP App metadata from a single tool definition's `_meta.ui` field.
 *
 * A tool qualifies as an MCP App when:
 *  - `_meta.ui.visibility` includes `"app"` (the tool is callable from the
 *    rendered iframe)
 *  - `_meta.ui.resourceUri` is a `ui://` URI (the HTML resource to render)
 *
 * Returns the structured `MCPAppInfo` for the host to route read-resource
 * and call-tool requests, or `undefined` when the tool has no app metadata.
 */
export function extractMcpAppInfo(
  tool: { name: string; _meta?: Record<string, unknown> },
  server: { id: string; name: string },
): MCPAppInfo | undefined {
  const meta = tool._meta;
  if (meta == null || typeof meta !== "object") return undefined;

  const uiMeta = meta.ui;
  if (uiMeta == null || typeof uiMeta !== "object") return undefined;

  const visibility = (uiMeta as Record<string, unknown>).visibility;
  if (
    !Array.isArray(visibility) ||
    !visibility.every((v) => v === "model" || v === "app") ||
    !visibility.includes("app")
  ) {
    return undefined;
  }

  const resourceUri = (uiMeta as Record<string, unknown>).resourceUri;
  if (
    typeof resourceUri !== "string" ||
    !resourceUri.startsWith("ui://")
  ) {
    return undefined;
  }

  return {
    toolName: tool.name,
    resourceUri,
    serverName: server.name,
    serverId: server.id,
  };
}

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
  // Pre-mutation snapshot for the dirty check below: applyDriftPolicy may
  // add TOFU baseline entries into `baselines` during collection. A
  // structuredClone guarantees the snapshot never aliases the mutated
  // object even if the settings layer starts caching parsed values.
  const previousBaselines = structuredClone(baselines);
  const previousStatus = getMcpStatusMap(db);
  const leases: Array<{ release: () => Promise<void> }> = [];
  const statuses: McpCollectionStatus[] = [];
  const tools: McpToolBag = {};
  const instructionBlocks: string[] = [];
  const usedSlugs = new Set<string>();
  const mcpApps: MCPAppInfo[] = [];

  const results = await Promise.allSettled(
    servers.map(async (config) => {
      const { client, release } = await mcpClientPool.leaseClient(
        config,
        connect
      );
      leases.push({ release });
      try {
        // Tool listing cache: the pool entry survives across chat requests
        // (5-min idle TTL) and config changes force eviction, so a cached
        // listing is valid for the entry's lifetime. This skips a full
        // tools/list JSON-RPC round-trip per server on every message.
        // The cache lives on the pool entry, NOT in this closure — a
        // second pass with a `connect` override (tests, drift re-approve)
        // creates a different entry and re-lists.
        let serverTools = mcpClientPool.getCachedToolBag<McpToolBag>(config.id);
        if (!serverTools) {
          serverTools = await withTimeout(
            client.tools(),
            MCP_TOOLS_TIMEOUT_MS,
            `MCP tool listing for "${config.name}"`
          );
          mcpClientPool.setCachedToolBag(config.id, serverTools);
        }
        const { tools: allowed, drift } = await applyDriftPolicy(
          config.id,
          serverTools,
          baselines
        );

        // MCP Apps: split into model-visible (passed to streamText) and
        // app-visible (rendered in iframes, proxied via API routes).
        // `splitMCPAppTools` operates on ListToolsResult-shape tool definitions
        // that carry `_meta.ui`. The AI SDK Tool bag from `client.tools()`
        // retains `_meta` but stores the tool name as the bag key (not a
        // property on the Tool object), so we promote the name into each
        // constructed definition entry.
        const definitions: ListToolsResult = {
          tools: Object.entries(allowed).map(([name, tool]) => ({
            name,
            inputSchema: {},
            _meta: tool._meta,
          })),
        };
        const splitResult = splitMCPAppTools(definitions);
        const modelVisibleNames = new Set(
          splitResult.modelVisible.tools.map((t) => t.name),
        );

        // Collect app info for the host to route read-resource / call-tool.
        const serverAppInfos: MCPAppInfo[] = [];
        for (const appTool of splitResult.appVisible.tools) {
          const info = extractMcpAppInfo(
            appTool as { name: string; _meta?: Record<string, unknown> },
            { id: config.id, name: config.name },
          );
          if (info) serverAppInfos.push(info);
        }

        // Unique per-server slug → "slug__toolName" keys.
        let slug = slugifyServerName(config.name);
        if (usedSlugs.has(slug)) {
          let n = 2;
          while (usedSlugs.has(`${slug}-${n}`)) n += 1;
          slug = `${slug}-${n}`;
        }
        usedSlugs.add(slug);

        // Built-in precedence with a user-controlled release valve: a
        // server tool whose underlying name duplicates a local tool is
        // withheld, unless (a) the built-in is globally disabled via the
        // Tools tab (no conflict — the duplicate restores the capability)
        // or (b) the user explicitly released this name on the server
        // config (allowDuplicates). Released tools are exposed under
        // their slug prefix and recorded in the status — never a silent
        // drop, never a silent release.
        let count = 0;
        const withheld: Array<{ tool: string; reason: string }> = [];
        const exposedDuplicates: string[] = [];
        const disabledBuiltins = getDisabledTools(db);
        const disabledSet = new Set(disabledBuiltins);
        for (const [toolName, tool] of Object.entries(allowed)) {
          // MCP Apps: app-only tools (visibility includes "app" but not
          // "model") are withheld from the model — they are rendered in
          // sandboxed iframes instead. Only model-visible tools are exposed
          // to streamText.
          if (!modelVisibleNames.has(toolName)) continue;

          const why = protectedToolReason(toolName, {
            disabledBuiltins: disabledSet,
            allowDuplicates: config.allowDuplicates,
          });
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
          if (
            toolName in builtinTools &&
            (config.allowDuplicates?.includes(toolName) || disabledSet.has(toolName))
          ) {
            exposedDuplicates.push(toolName);
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

        return {
          serverId: config.id,
          status: {
            ok: true,
            toolCount: count,
            serverName: client.serverInfo?.name,
            protocolVersion: client.initializeResult?.protocolVersion,
            ...(drift ? { drift } : {}),
            ...(withheld.length > 0 ? { withheld } : {}),
            ...(exposedDuplicates.length > 0 ? { exposedDuplicates } : {}),
            lastAttemptAt: new Date().toISOString(),
          } satisfies McpServerRuntimeStatus,
          collection: {
            serverId: config.id,
            name: config.name,
            ok: true,
            toolCount: count,
            ...(drift ? { drift } : {}),
            ...(withheld.length > 0 ? { withheld } : {}),
            ...(exposedDuplicates.length > 0 ? { exposedDuplicates } : {}),
          } satisfies McpCollectionStatus,
          apps: serverAppInfos,
        };
      } catch (error) {
        // Evict through the pool so the shared pooled client is closed
        // and never handed to a later lease; a bare client.close() here
        // would leave a poisoned entry in the pool.
        try {
          await mcpClientPool.evict(config.id);
        } catch (evictError) {
          console.warn(
            `[mcp] Failed to evict pooled client for "${config.name}":`,
            evictError
          );
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
      for (const app of result.value.apps) mcpApps.push(app);
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

  // Persist baselines (may include new TOFU entries) and statuses — but
  // only when something actually changed. A steady-state chat turn
  // produces the same baselines and (modulo lastAttemptAt) the same
  // statuses; re-serializing both into SQLite on every message was pure
  // write amplification on the request path.
  try {
    const baselinesChanged =
      JSON.stringify(baselines) !== JSON.stringify(previousBaselines);
    const statusesChanged =
      JSON.stringify(statusMap) !== JSON.stringify(previousStatus);
    if (baselinesChanged || statusesChanged) {
      const patch: Record<string, unknown> = {};
      if (baselinesChanged) patch[MCP_BASELINES_KEY] = baselines;
      if (statusesChanged) patch[MCP_STATUS_KEY] = statusMap;
      setSettingsDb(patch, db);
    }
  } catch (error) {
    console.warn("[mcp] Failed to persist baselines/status:", error);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(
      leases.map(async (lease) => {
        try {
          await lease.release();
        } catch (error) {
          console.warn("[mcp] Error releasing MCP client lease:", error);
        }
      })
    );
  };

  const instructions =
    instructionBlocks.length > 0
      ? `# MCP Server Instructions\nThe following instructions were provided by connected MCP servers:\n\n${instructionBlocks.join("\n\n")}`
      : "";

  return { tools, instructions, close, statuses, apps: mcpApps };
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
