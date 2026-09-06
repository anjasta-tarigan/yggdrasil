import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createMCPClient, type JSONRPCMessage, type MCPTransport } from "@ai-sdk/mcp";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { setSettingsDb } from "@/lib/settings-service";
import { MCP_SERVERS_KEY, type McpServerConfig } from "../config";
import {
  collectMcpTools,
  getMcpBaselines,
  getMcpStatusMap,
  refreshMcpBaseline,
  testMcpServerConnection,
  type McpConnectFn,
} from "../manager";
import { mcpClientPool } from "../pool";

/**
 * In-memory MCP server transport: speaks just enough JSON-RPC for the
 * legacy initialize handshake and tools/list so `createMCPClient` works
 * without any network or child processes.
 */
class FakeMcpServerTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  closed = false;

  constructor(
    private opts: {
      tools: Array<{ name: string; description?: string }>;
      serverName?: string;
      instructions?: string;
      failInitialize?: boolean;
    }
  ) {}

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (
      typeof message !== "object" ||
      message === null ||
      !("method" in message) ||
      typeof message.method !== "string"
    ) {
      return;
    }
    const id = "id" in message ? message.id : undefined;

    if (message.method === "initialize") {
      if (this.opts.failInitialize) {
        this.reply(id, { error: { code: -32603, message: "init failed" } });
        return;
      }
      const params = (message as { params?: { protocolVersion?: string } })
        .params;
      this.reply(id, {
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: this.opts.serverName ?? "fake-server",
            version: "1.0.0",
          },
          ...(this.opts.instructions
            ? { instructions: this.opts.instructions }
            : {}),
        },
      });
      return;
    }

    if (message.method === "tools/list") {
      this.reply(id, {
        result: {
          tools: this.opts.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? `Fake tool ${tool.name}`,
            inputSchema: { type: "object", properties: {} },
          })),
        },
      });
      return;
    }
    // notifications/initialized and anything else: no response.
  }

  private reply(
    id: string | number | undefined,
    payload: { result?: unknown; error?: { code: number; message: string } }
  ): void {
    queueMicrotask(() => {
      this.onmessage?.({
        jsonrpc: "2.0",
        id,
        ...payload,
      } as unknown as JSONRPCMessage);
    });
  }
}

type FakeServerSpec = {
  tools: Array<{ name: string; description?: string }>;
  serverName?: string;
  instructions?: string;
  failInitialize?: boolean;
};

function makeConnect(
  specs: Record<string, FakeServerSpec>,
  transports: FakeMcpServerTransport[] = []
): McpConnectFn {
  return (config) => {
    const spec = specs[config.id] ?? { tools: [] };
    const transport = new FakeMcpServerTransport(spec);
    transports.push(transport);
    return createMCPClient({ transport, clientName: "test-client" });
  };
}

function makeServer(overrides: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "srv-1",
    name: "Weather",
    transport: "http",
    enabled: true,
    url: "https://fake.invalid/mcp",
    ...overrides,
  };
}

describe("MCP manager", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  afterEach(async () => {
    await mcpClientPool.clear();
  });

  const seedServers = (servers: McpServerConfig[]) => {
    setSettingsDb({ [MCP_SERVERS_KEY]: servers }, testDb);
  };

  it("collects slug-prefixed tools from enabled servers and skips disabled ones", async () => {
    seedServers([
      makeServer({ id: "srv-w", name: "Weather" }),
      makeServer({ id: "srv-f", name: "Local Files", transport: "stdio", url: undefined, command: "fake" }),
      makeServer({ id: "srv-d", name: "Off", enabled: false }),
    ]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-w": { tools: [{ name: "get_forecast" }] },
        "srv-f": { tools: [{ name: "read_file" }] },
        "srv-d": { tools: [{ name: "never_seen" }] },
      }),
    });

    expect(Object.keys(collection.tools).sort()).toEqual([
      "local-files__read_file",
      "weather__get_forecast",
    ]);
    expect(collection.statuses).toHaveLength(2);
    expect(collection.statuses.every((s) => s.ok)).toBe(true);
    await collection.close();
  });

  it("deduplicates colliding server slugs", async () => {
    seedServers([
      makeServer({ id: "srv-a", name: "Data" }),
      makeServer({ id: "srv-b", name: "Data" }),
    ]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-a": { tools: [{ name: "query" }] },
        "srv-b": { tools: [{ name: "query" }] },
      }),
    });

    expect(Object.keys(collection.tools).sort()).toEqual([
      "data-2__query",
      "data__query",
    ]);
    await collection.close();
  });

  it("aggregates server instructions for the system prompt", async () => {
    seedServers([makeServer({ id: "srv-w", name: "Weather" })]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-w": {
          tools: [{ name: "get_forecast" }],
          instructions: "Always include units.",
        },
      }),
    });

    expect(collection.instructions).toContain("MCP Server Instructions");
    expect(collection.instructions).toContain('name="Weather"');
    expect(collection.instructions).toContain("Always include units.");
    await collection.close();
  });

  it("does NOT withhold MCP capability tools (web_search/web_fetch) — they coexist under slug prefix", async () => {
    seedServers([
      makeServer({
        id: "srv-parallel",
        name: "parallel-search",
      }),
    ]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-parallel": {
          tools: [
            { name: "web_search" },
            { name: "web_fetch" },
            { name: "get_forecast" },
          ],
        },
      }),
    });
    await collection.close();

    // Capability tools are NOT withheld — exposed under slug prefix alongside
    // the non-colliding tool. The model has both the built-in and the MCP
    // namespaced version.
    expect(Object.keys(collection.tools).sort()).toEqual([
      "parallel-search__get_forecast",
      "parallel-search__web_fetch",
      "parallel-search__web_search",
    ]);

    // No tools withheld.
    const status = getMcpStatusMap(testDb)["srv-parallel"];
    expect(status.toolCount).toBe(3);
    expect(status.withheld).toBeUndefined();
  });

  it("withholds MCP tools whose underlying name duplicates a non-capability built-in", async () => {
    seedServers([
      makeServer({
        id: "srv-builtin",
        name: "builtin-clone",
      }),
    ]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-builtin": {
          tools: [
            { name: "web_search" },  // capability — NOT withheld
            { name: "task_list_manager" },  // built-in, not a capability — withheld
            { name: "get_forecast" },
          ],
        },
      }),
    });
    await collection.close();

    // web_search coexists; task_list_manager is withheld
    expect(Object.keys(collection.tools).sort()).toEqual([
      "builtin-clone__get_forecast",
      "builtin-clone__web_search",
    ]);

    const status = getMcpStatusMap(testDb)["srv-builtin"];
    expect(status.toolCount).toBe(2);
    expect(status.withheld).toEqual([
      {
        tool: "task_list_manager",
        reason: expect.stringContaining("built-in"),
      },
    ]);
  });

  it("withholds MCP tools whose name duplicates the sandbox or delegation tools", async () => {
    seedServers([makeServer({ id: "srv-x", name: "Misc" })]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-x": {
          tools: [
            { name: "bash" },
            { name: "readFile" },
            { name: "writeFile" },
            { name: "delegate_researcher" },
          ],
        },
      }),
    });
    await collection.close();

    expect(Object.keys(collection.tools)).toEqual([]);
    const status = getMcpStatusMap(testDb)["srv-x"];
    expect(status.toolCount).toBe(0);
    expect(status.withheld?.map((w) => w.tool)).toEqual([
      "bash",
      "readFile",
      "writeFile",
      "delegate_researcher",
    ]);
    // Reasons are accurate per collision class, not blanket "built-in".
    const byTool = new Map(status.withheld?.map((w) => [w.tool, w.reason]));
    expect(byTool.get("bash")).toContain("sandbox");
    expect(byTool.get("bash")).not.toContain("built-in");
    expect(byTool.get("delegate_researcher")).toContain("reserved");
    expect(byTool.get("delegate_researcher")).not.toContain("built-in");
  });

  it("suppresses server instructions when every server tool was withheld", async () => {
    seedServers([makeServer({ id: "srv-w", name: "withholder" })]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-w": {
          tools: [{ name: "task_list_manager" }],  // built-in, not a capability — withheld
          instructions: "Use this for task planning.",
        },
      }),
    });
    await collection.close();

    // The directive must not steer the model at a withheld tool.
    expect(collection.instructions).toBe("");
  });

  it("keeps server instructions when the server contributes at least one tool", async () => {
    seedServers([makeServer({ id: "srv-mixed", name: "mixed" })]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-mixed": {
          tools: [{ name: "web_search" }, { name: "get_forecast" }],
          instructions: "Always include units.",
        },
      }),
    });
    await collection.close();

    // web_search is a capability tool — not withheld, so it counts.
    expect(Object.keys(collection.tools).sort()).toEqual([
      "mixed__get_forecast",
      "mixed__web_search",
    ]);
    expect(collection.instructions).toContain("Always include units.");
  });

  it("exposes a released duplicate under its slug prefix and records it", async () => {
    seedServers([
      makeServer({
        id: "srv-parallel",
        name: "parallel-search",
        allowDuplicates: ["web_search"],
      }),
    ]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-parallel": {
          tools: [{ name: "web_search" }, { name: "get_forecast" }],
        },
      }),
    });
    await collection.close();

    // The released duplicate flows, namespaced — never shadowing the
    // built-in. The model has both and chooses per call.
    expect(Object.keys(collection.tools)).toEqual([
      "parallel-search__web_search",
      "parallel-search__get_forecast",
    ]);

    const status = getMcpStatusMap(testDb)["srv-parallel"];
    expect(status.toolCount).toBe(2);
    expect(status.withheld).toBeUndefined();
    expect(status.exposedDuplicates).toEqual(["web_search"]);
    expect(collection.statuses[0].exposedDuplicates).toEqual(["web_search"]);
  });

  it("keeps non-releasable collisions withheld even when allowDuplicates lists them", async () => {
    seedServers([
      makeServer({
        id: "srv-x",
        name: "Misc",
        // Attempt to release sandbox and delegation collisions: the
        // release valve is built-in-only by design.
        allowDuplicates: ["bash", "delegate_researcher"],
      }),
    ]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-x": {
          tools: [
            { name: "bash" },
            { name: "delegate_researcher" },
            { name: "get_forecast" },
          ],
        },
      }),
    });
    await collection.close();

    expect(Object.keys(collection.tools)).toEqual(["misc__get_forecast"]);
    const status = getMcpStatusMap(testDb)["srv-x"];
    expect(status.withheld?.map((w) => w.tool)).toEqual([
      "bash",
      "delegate_researcher",
    ]);
    expect(status.exposedDuplicates).toBeUndefined();
  });

  it("flows a duplicate when the built-in is globally disabled, without a release", async () => {
    // Layer 2 coherence: the Tools tab disabled the built-in task_list_manager,
    // so the MCP duplicate restores the capability with no explicit release
    // needed. (web_search is a capability tool and always coexists — see the
    // dedicated capability test above.)
    seedServers([
      makeServer({ id: "srv-clone", name: "task-clone" }),
    ]);
    setSettingsDb({ toolToggles: { disabled: ["task_list_manager"] } }, testDb);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-clone": { tools: [{ name: "task_list_manager" }] },
      }),
    });
    await collection.close();

    expect(Object.keys(collection.tools)).toEqual([
      "task-clone__task_list_manager",
    ]);
    const status = getMcpStatusMap(testDb)["srv-clone"];
    expect(status.toolCount).toBe(1);
    expect(status.withheld).toBeUndefined();
    expect(status.exposedDuplicates).toEqual(["task_list_manager"]);
  });

  it("saves a trust-on-first-use baseline and ok status", async () => {
    seedServers([makeServer({ id: "srv-w", name: "Weather" })]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-w": { tools: [{ name: "get_forecast" }], serverName: "wx" },
      }),
    });
    await collection.close();

    const baselines = getMcpBaselines(testDb);
    expect(Object.keys(baselines["srv-w"].fingerprints)).toEqual([
      "get_forecast",
    ]);

    const status = getMcpStatusMap(testDb)["srv-w"];
    expect(status.ok).toBe(true);
    expect(status.toolCount).toBe(1);
    expect(status.serverName).toBe("wx");
    expect(status.drift).toBeUndefined();
  });

  it("withholds changed and newly added tools until re-approval", async () => {
    seedServers([makeServer({ id: "srv-w", name: "Weather" })]);

    // First contact: baseline captured for tools A and B.
    const first = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-w": {
          tools: [
            { name: "a", description: "version one" },
            { name: "b", description: "stable" },
          ],
        },
      }),
    });
    expect(Object.keys(first.tools).sort()).toEqual(["weather__a", "weather__b"]);
    await first.close();
    // Simulate a server-side tool change observed on a new turn: evict
    // the pooled client/fingerprints so the next collection re-discovers tools.
    await mcpClientPool.evict("srv-w");

    // Second contact: description of A mutated, C added, B unchanged.
    const second = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-w": {
          tools: [
            { name: "a", description: "INJECTED new instructions" },
            { name: "b", description: "stable" },
            { name: "c", description: "brand new" },
          ],
        },
      }),
    });

    expect(Object.keys(second.tools)).toEqual(["weather__b"]);
    const driftStatus = second.statuses.find((s) => s.serverId === "srv-w");
    expect(driftStatus?.drift?.changed).toEqual(["a"]);
    expect(driftStatus?.drift?.added).toEqual(["c"]);
    await second.close();

    // Drift is persisted for the MCP page; baseline stays at the
    // approved definitions (2 tools).
    const status = getMcpStatusMap(testDb)["srv-w"];
    expect(status.drift?.changed).toEqual(["a"]);
    expect(status.drift?.added).toEqual(["c"]);
    const baselines = getMcpBaselines(testDb);
    expect(Object.keys(baselines["srv-w"].fingerprints).sort()).toEqual([
      "a",
      "b",
    ]);
  });

  it("re-approval refreshes the baseline and clears drift", async () => {
    seedServers([makeServer({ id: "srv-w", name: "Weather" })]);

    const specs: Record<string, FakeServerSpec> = {
      "srv-w": { tools: [{ name: "a", description: "one" }] },
    };
    const first = await collectMcpTools({ db: testDb, connect: makeConnect(specs) });
    await first.close();
    await mcpClientPool.evict("srv-w");

    // Server mutates its tool → drift on the next pass.
    specs["srv-w"] = { tools: [{ name: "a", description: "two" }] };
    const second = await collectMcpTools({ db: testDb, connect: makeConnect(specs) });
    expect(Object.keys(second.tools)).toEqual([]);
    await second.close();

    const result = await refreshMcpBaseline("srv-w", testDb, makeConnect(specs));
    expect(result).toEqual({ ok: true, toolCount: 1 });

    const status = getMcpStatusMap(testDb)["srv-w"];
    expect(status.ok).toBe(true);
    expect(status.drift).toBeUndefined();

    // The mutated definition is now approved and served again.
    const third = await collectMcpTools({ db: testDb, connect: makeConnect(specs) });
    expect(Object.keys(third.tools)).toEqual(["weather__a"]);
    await third.close();
  });

  it("reports unknown server ids on re-approval", async () => {
    const result = await refreshMcpBaseline("missing", testDb);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown/i);
  });

  it("keeps collecting from healthy servers when one fails", async () => {
    seedServers([
      makeServer({ id: "srv-bad", name: "Broken" }),
      makeServer({ id: "srv-ok", name: "Healthy" }),
    ]);

    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({
        "srv-bad": { tools: [], failInitialize: true },
        "srv-ok": { tools: [{ name: "ping" }] },
      }),
    });

    expect(Object.keys(collection.tools)).toEqual(["healthy__ping"]);
    const broken = collection.statuses.find((s) => s.serverId === "srv-bad");
    const healthy = collection.statuses.find((s) => s.serverId === "srv-ok");
    expect(broken?.ok).toBe(false);
    expect(broken?.error).toBeTruthy();
    expect(healthy?.ok).toBe(true);

    // Failure is persisted for the MCP page.
    const status = getMcpStatusMap(testDb)["srv-bad"];
    expect(status.ok).toBe(false);
    await collection.close();
  });

  it("closes every opened client exactly once", async () => {
    seedServers([
      makeServer({ id: "srv-w", name: "Weather" }),
      makeServer({ id: "srv-f", name: "Files" }),
    ]);

    const transports: FakeMcpServerTransport[] = [];
    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect(
        {
          "srv-w": { tools: [{ name: "a" }] },
          "srv-f": { tools: [{ name: "b" }] },
        },
        transports
      ),
    });

    expect(transports).toHaveLength(2);
    await collection.close();
    await collection.close(); // idempotent
    // Pooled clients are held for reuse, not closed on lease release.
    expect(transports.every((t) => !t.closed)).toBe(true);
  });

  it("reuses pooled clients and cached fingerprints across collections", async () => {
    seedServers([makeServer({ id: "srv-pool", name: "Weather" })]);

    const transports: FakeMcpServerTransport[] = [];
    // One connect fn per collection, both pointing at the same pool: a
    // pooled client means the second collection never calls connect again.
    const connect = makeConnect(
      { "srv-pool": { tools: [{ name: "get_forecast" }] } },
      transports
    );

    const first = await collectMcpTools({ db: testDb, connect });
    expect(Object.keys(first.tools)).toEqual(["weather__get_forecast"]);
    const firstFingerprints = mcpClientPool.getCachedFingerprints("srv-pool");
    expect(Object.keys(firstFingerprints ?? {})).toEqual(["get_forecast"]);
    await first.close();

    const second = await collectMcpTools({ db: testDb, connect });
    expect(Object.keys(second.tools)).toEqual(["weather__get_forecast"]);
    // Same transport reused: the client was released to the pool, not closed.
    expect(transports).toHaveLength(1);
    expect(transports[0].closed).toBe(false);
    expect(mcpClientPool.getCachedFingerprints("srv-pool")).toEqual(
      firstFingerprints
    );
    await second.close();
  });

  it("returns an empty collection when nothing is configured", async () => {
    const collection = await collectMcpTools({
      db: testDb,
      connect: makeConnect({}),
    });
    expect(Object.keys(collection.tools)).toEqual([]);
    expect(collection.instructions).toBe("");
    await collection.close();
  });
});

describe("testMcpServerConnection", () => {
  it("lists tools and server info without persisting anything", async () => {
    const sqlite = new Database(":memory:");
    setupFtsAndTriggers(sqlite);
    const testDb = drizzle(sqlite, { schema });

    const result = await testMcpServerConnection(
      makeServer({ id: "srv-t", name: "Probe" }),
      makeConnect({
        "srv-t": {
          tools: [{ name: "x", description: "does x" }],
          serverName: "probe-server",
          instructions: "be nice",
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(result.serverName).toBe("probe-server");
    expect(result.tools).toEqual([{ name: "x", description: "does x" }]);
    expect(result.instructions).toBe("be nice");
    expect(getMcpBaselines(testDb)).toEqual({});
    expect(getMcpStatusMap(testDb)).toEqual({});
  });

  it("reports connection failures as ok:false", async () => {
    const result = await testMcpServerConnection(
      makeServer({ id: "srv-t", name: "Probe" }),
      makeConnect({ "srv-t": { tools: [], failInitialize: true } })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
