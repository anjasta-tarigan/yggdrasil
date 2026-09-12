import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readMCPAppResource,
  splitMCPAppTools,
  type ListToolsResult,
  type MCPAppResource,
} from "@ai-sdk/mcp";
import {
  collectMcpTools,
  extractMcpAppInfo,
  type MCPAppInfo,
} from "@/lib/ai/mcp/manager";
import { mcpClientPool } from "@/lib/ai/mcp/pool";
import type { AppDatabase } from "@/db";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { setSettingsDb } from "@/lib/settings-service";
import { MCP_SERVERS_KEY, type McpServerConfig } from "@/lib/ai/mcp/config";
import { createMCPClient, type JSONRPCMessage, type MCPTransport } from "@ai-sdk/mcp";
import type { McpConnectFn } from "@/lib/ai/mcp/manager";

/**
 * Minimal in-memory MCP transport for tests. Supports initialize,
 * tools/list (with optional `_meta.ui` on tool definitions), and
 * resources/read so `readMCPAppResource` can be exercised end-to-end.
 */
class FakeMcpServerTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private opts: {
      tools: Array<Record<string, unknown>>;
      serverName?: string;
      instructions?: string;
      resourceContents?: Array<Record<string, unknown>>;
    },
  ) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {
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
      const params = (message as { params?: { protocolVersion?: string } })
        .params;
      this.reply(id, {
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false }, resources: {} },
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
          tools: this.opts.tools,
        },
      });
      return;
    }

    if (message.method === "resources/read") {
      const params = message as {
        params?: { uri?: string };
      };
      const contents = this.opts.resourceContents ?? [];
      const match = contents.find(
        (c) => c.uri === params?.params?.uri,
      );
      this.reply(id, {
        result: {
          contents: match ? [match] : [],
        },
      });
      return;
    }
    // notifications/initialized and anything else: no response.
  }

  private reply(
    id: string | number | undefined,
    payload: { result?: unknown; error?: { code: number; message: string } },
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

function makeConnect(
  specs: Record<
    string,
    {
      tools: Array<Record<string, unknown>>;
      resourceContents?: Array<Record<string, unknown>>;
      serverName?: string;
      instructions?: string;
    }
  >,
): McpConnectFn {
  return (config) => {
    const spec = specs[config.id] ?? { tools: [] };
    const transport = new FakeMcpServerTransport(spec);
    return createMCPClient({ transport, clientName: "test-client" });
  };
}

function makeServer(overrides: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: "srv-1",
    name: "TestApp",
    transport: "http",
    enabled: true,
    url: "https://fake.invalid/mcp",
    ...overrides,
  };
}

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupFtsAndTriggers(sqlite);
  return drizzle(sqlite, { schema });
}

function seedServers(servers: McpServerConfig[], db: AppDatabase) {
  setSettingsDb({ [MCP_SERVERS_KEY]: servers }, db);
}

// ---- Test helpers for raw tool definitions ----

function makeDefinition(
  name: string,
  visibility?: Array<"model" | "app">,
  resourceUri?: string,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
  if (visibility !== undefined || resourceUri !== undefined) {
    tool._meta = {
      ui: {
        ...(visibility !== undefined ? { visibility } : {}),
        ...(resourceUri !== undefined ? { resourceUri } : {}),
      },
    };
  }
  return tool;
}

describe("MCP Apps", () => {
  describe("splitMCPAppTools", () => {
    it("separates model-visible, app-visible, and dual-visibility tools", () => {
      const definitions = {
        tools: [
          makeDefinition("modelOnly", ["model"], "ui://srv/model-only"),
          makeDefinition("appOnly", ["app"], "ui://srv/app-only"),
          makeDefinition("both", ["model", "app"], "ui://srv/both"),
          makeDefinition("noMeta"),
        ],
      } as unknown as ListToolsResult;

      const { modelVisible, appVisible } = splitMCPAppTools(definitions);

      // model-visible: modelOnly, both, noMeta (3 tools)
      expect(modelVisible.tools.map((t) => t.name).sort()).toEqual([
        "both",
        "modelOnly",
        "noMeta",
      ]);

      // app-visible: appOnly, both (2 tools)
      expect(appVisible.tools.map((t) => t.name).sort()).toEqual([
        "appOnly",
        "both",
      ]);
    });

    it("keeps a tool with no _meta.ui as model-visible only", () => {
      const definitions = {
        tools: [makeDefinition("plain")],
      } as unknown as ListToolsResult;

      const { modelVisible, appVisible } = splitMCPAppTools(definitions);

      expect(modelVisible.tools).toHaveLength(1);
      expect(appVisible.tools).toHaveLength(0);
    });

    it("treats visibility with only 'model' as model-visible only", () => {
      const definitions = {
        tools: [makeDefinition("modelOnly", ["model"])],
      } as unknown as ListToolsResult;

      const { modelVisible, appVisible } = splitMCPAppTools(definitions);

      expect(modelVisible.tools).toHaveLength(1);
      expect(appVisible.tools).toHaveLength(0);
    });
  });

  describe("readMCPAppResource", () => {
    const mockClient = {
      readResource: async ({ uri }: { uri: string }) => ({
        contents: [
          {
            uri,
            mimeType: "text/html;profile=mcp-app",
            text: "<html><body>MCP App</body></html>",
            _meta: {
              ui: {
                csp: {
                  connectDomains: ["https://api.example.com"],
                  resourceDomains: ["https://cdn.example.com"],
                },
              },
            },
          },
        ],
      }),
    };

    it("normalizes a ui:// resource into MCPAppResource with html, mimeType, and csp", async () => {
      const result = await readMCPAppResource({
        client: mockClient,
        uri: "ui://srv/app",
      });

      expect(result.uri).toBe("ui://srv/app");
      expect(result.mimeType).toBe("text/html;profile=mcp-app");
      expect(result.html).toBe("<html><body>MCP App</body></html>");
      expect(result.meta?.csp).toEqual({
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      });
    });

    it("decodes base64 blob content", async () => {
      const blobClient = {
        readResource: async () => ({
          contents: [
            {
              uri: "ui://srv/blob-app",
              mimeType: "text/html;profile=mcp-app",
              blob: btoa("<html><body>Blob App</body></html>"),
            },
          ],
        }),
      };

      const result = await readMCPAppResource({
        client: blobClient,
        uri: "ui://srv/blob-app",
      });

      expect(result.html).toBe("<html><body>Blob App</body></html>");
    });

    it("rejects non-ui:// URIs", async () => {
      await expect(
        readMCPAppResource({ client: mockClient, uri: "http://evil.com" }),
      ).rejects.toThrow(/Unsupported MCP App resource URI/);
    });

    it("rejects resources with the wrong MIME type", async () => {
      const wrongMimeClient = {
        readResource: async () => ({
          contents: [
            {
              uri: "ui://srv/wrong",
              mimeType: "text/plain",
              text: "not an app",
            },
          ],
        }),
      };

      await expect(
        readMCPAppResource({ client: wrongMimeClient, uri: "ui://srv/wrong" }),
      ).rejects.toThrow(/Unsupported MCP App resource MIME type/);
    });
  });

  describe("extractMcpAppInfo", () => {
    it("extracts info from a tool with app visibility and ui:// resourceUri", () => {
      const tool = {
        name: "show_dashboard",
        _meta: {
          ui: {
            visibility: ["app"],
            resourceUri: "ui://example/dashboard",
          },
        },
      };

      const info = extractMcpAppInfo(tool, {
        id: "srv-ex",
        name: "Example",
      });

      expect(info).toEqual<MCPAppInfo>({
        toolName: "show_dashboard",
        resourceUri: "ui://example/dashboard",
        serverName: "Example",
        serverId: "srv-ex",
      });
    });

    it("returns undefined when the tool has no _meta", () => {
      const tool = { name: "plainTool" };
      expect(extractMcpAppInfo(tool, { id: "s", name: "S" })).toBeUndefined();
    });

    it("returns undefined when visibility does not include 'app'", () => {
      const tool = {
        name: "onlyModel",
        _meta: { ui: { visibility: ["model"], resourceUri: "ui://x" } },
      };
      expect(
        extractMcpAppInfo(tool, { id: "s", name: "S" }),
      ).toBeUndefined();
    });

    it("returns undefined when resourceUri is not a ui:// URI", () => {
      const tool = {
        name: "badUri",
        _meta: { ui: { visibility: ["app"], resourceUri: "http://evil.com" } },
      };
      expect(
        extractMcpAppInfo(tool, { id: "s", name: "S" }),
      ).toBeUndefined();
    });

    it("returns undefined when visibility is missing entirely", () => {
      const tool = {
        name: "noVisibility",
        _meta: { ui: { resourceUri: "ui://x" } },
      };
      expect(
        extractMcpAppInfo(tool, { id: "s", name: "S" }),
      ).toBeUndefined();
    });
  });

  describe("collectMcpTools with MCP Apps", () => {
    let db: AppDatabase;
    beforeEach(() => {
      db = makeDb();
    });
    afterEach(async () => {
      await mcpClientPool.clear();
    });

    it("withholds app-only tools from the model-visible tools bag and collects app info", async () => {
      seedServers([makeServer({ id: "srv-app", name: "DashboardApp" })], db);

      const collection = await collectMcpTools({
        db,
        connect: makeConnect({
          "srv-app": {
            tools: [
              // Model-visible tool
              makeDefinition("get_weather", ["model"]),
              // App-only tool (has a ui:// resource)
              makeDefinition("show_dashboard", ["app"], "ui://dashboards/app"),
              // Tool visible to both model and app
              makeDefinition("get_data", ["model", "app"], "ui://dashboards/data"),
              // Plain tool, no MCP Apps metadata
              makeDefinition("plain_tool"),
            ],
          },
        }),
      });

      // Only model-visible tools should be in the tools bag
      expect(Object.keys(collection.tools).sort()).toEqual([
        "dashboardapp__get_data",
        "dashboardapp__get_weather",
        "dashboardapp__plain_tool",
      ]);

      // App info should be collected for app-visible tools
      expect(collection.apps).toHaveLength(2);
      const appNames = collection.apps.map((a) => a.toolName).sort();
      expect(appNames).toEqual(["get_data", "show_dashboard"]);

      const dashboard = collection.apps.find((a) => a.toolName === "show_dashboard");
      expect(dashboard).toMatchObject({
        resourceUri: "ui://dashboards/app",
        serverName: "DashboardApp",
        serverId: "srv-app",
      });

      await collection.close();
    });

    it("returns an empty apps array when no tools have app metadata", async () => {
      seedServers([makeServer({ id: "srv-plain", name: "PlainServer" })], db);

      const collection = await collectMcpTools({
        db,
        connect: makeConnect({
          "srv-plain": {
            tools: [makeDefinition("tool_a"), makeDefinition("tool_b")],
          },
        }),
      });

      expect(collection.apps).toEqual([]);
      expect(Object.keys(collection.tools).sort()).toEqual([
        "plainserver__tool_a",
        "plainserver__tool_b",
      ]);

      await collection.close();
    });
  });
});
