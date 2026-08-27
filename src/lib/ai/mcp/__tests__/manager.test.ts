import { beforeEach, describe, expect, it } from "vitest";
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
    expect(transports.every((t) => t.closed)).toBe(true);
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
