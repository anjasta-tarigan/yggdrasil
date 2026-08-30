import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { GET, PUT } from "../settings/route";

const getSettingsDbMock = vi.fn();
const setSettingsDbMock = vi.fn();

vi.mock("@/lib/settings-service", () => ({
  getSettingsDb: (...args: unknown[]) => getSettingsDbMock(...args),
  setSettingsDb: (...args: unknown[]) => setSettingsDbMock(...args),
  // Derive the single-key read from the store mock so both views agree.
  getSettingDb: (key: string) => {
    const store = getSettingsDbMock() as Record<string, unknown> | undefined;
    return store ? store[key] : undefined;
  },
}));

vi.mock("@/lib/database-service", () => ({
  getDatabaseStats: vi.fn().mockReturnValue({
    engine: "SQLite",
    driver: "better-sqlite3 + drizzle-orm",
    features: ["WAL", "FTS5", "sqlite-vec"],
    path: "/tmp/test-yggdrasil.db",
    sizeBytes: 1234,
    chatCount: 3,
    messageCount: 7,
    memories: { episodic: 1, semantic: 2, working: 0 },
    queue: { pending: 0, completed: 5, failed: 1 },
  }),
}));

vi.mock("@/lib/ai/tools", () => ({
  chatTools: {
    web_search: { description: "Search the web" },
    web_fetch: { description: "Fetch a page" },
    reminder_schedule: { description: "Schedule a reminder" },
    ask_user_question: { description: "Ask the user" },
  },
}));

vi.mock("@/lib/ai/provider", () => ({
  defaultModelId: "test-model",
}));

describe("Settings API Handler", () => {
  const ENV_KEYS = ["EXA_API_KEY", "FIRECRAWL_API_KEY", "SEARXNG_BASE_URL"];
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsDbMock.mockReturnValue({});
    // Deterministic web search chain defaults for every test.
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.SEARXNG_BASE_URL;
  });

  it("GET returns snapshot with an empty store by default", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.store).toEqual({
      providers: [],
      embedding: {},
      websearch: {},
      mcpServers: [],
    });
    expect(data.about.name).toBe("Yggdrasil");
    // Live database statistics are included.
    expect(data.database.chatCount).toBe(3);
    expect(data.database.messageCount).toBe(7);
    expect(data.database.memories).toEqual({
      episodic: 1,
      semantic: 2,
      working: 0,
    });
    expect(data.database.queue).toEqual({
      pending: 0,
      completed: 5,
      failed: 1,
    });
    expect(data.database.path).toBe("/tmp/test-yggdrasil.db");
  });

  it("GET exposes stored providers and embedding settings", async () => {
    getSettingsDbMock.mockReturnValue({
      providers: [
        {
          id: "ollama-1",
          kind: "ollama",
          name: "Ollama",
          baseUrl: "http://localhost:11434",
        },
      ],
      embedding: { model: "nomic-embed-text" },
    });
    const res = await GET();
    const data = await res.json();
    expect(data.store.providers.length).toBe(1);
    expect(data.store.embedding.model).toBe("nomic-embed-text");
    // Snapshot reflects the stored embedding model.
    expect(data.embedding.model).toBe("nomic-embed-text");
  });

  it("PUT persists a valid provider registry", async () => {
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        providers: [
          {
            id: "custom-1",
            kind: "openai-compatible",
            name: "My endpoint",
            baseUrl: "http://localhost:20128/v1",
            apiKey: "sk-test",
          },
        ],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith({
      providers: [
        {
          id: "custom-1",
          kind: "openai-compatible",
          name: "My endpoint",
          baseUrl: "http://localhost:20128/v1",
          apiKey: "sk-test",
        },
      ],
    });
  });

  it("PUT strips apiKey from ollama providers", async () => {
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        providers: [
          {
            id: "ollama-1",
            kind: "ollama",
            name: "Ollama",
            baseUrl: "http://localhost:11434",
            apiKey: "should-be-dropped",
          },
        ],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const patch = setSettingsDbMock.mock.calls[0][0] as {
      providers: Array<{ apiKey?: string }>;
    };
    expect(patch.providers[0].apiKey).toBeUndefined();
  });

  it("PUT rejects invalid payloads", async () => {
    const cases = [
      // Not an object
      "[]",
      // Empty / unknown-key payloads are no-ops and rejected
      "{}",
      JSON.stringify({ somethingElse: true }),
      // Provider with non-http baseUrl
      JSON.stringify({
        providers: [
          {
            id: "x",
            kind: "ollama",
            name: "X",
            baseUrl: "file:///etc/passwd",
          },
        ],
      }),
      // Unknown provider kind
      JSON.stringify({
        providers: [
          {
            id: "x",
            kind: "anthropic",
            name: "X",
            baseUrl: "http://localhost:11434",
          },
        ],
      }),
      // Duplicate provider ids
      JSON.stringify({
        providers: [
          { id: "dup", kind: "ollama", name: "A", baseUrl: "http://a" },
          { id: "dup", kind: "ollama", name: "B", baseUrl: "http://b" },
        ],
      }),
      // Embedding model wrong type
      JSON.stringify({ embedding: { model: 42 } }),
    ];
    for (const body of cases) {
      const res = await PUT(
        new Request("http://localhost/api/settings", { method: "PUT", body })
      );
      expect(res.status).toBe(400);
    }
    expect(setSettingsDbMock).not.toHaveBeenCalled();
  });

  it("PUT rejects malformed JSON", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: "{not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("PUT persists a full embedding configuration", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          embedding: {
            provider: "ollama",
            baseUrl: "http://localhost:11434",
            model: "nomic-embed-text",
            dimensions: 768,
            chunkSize: 2000,
            chunkOverlap: 200,
          },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith({
      embedding: {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        model: "nomic-embed-text",
        dimensions: 768,
        chunkSize: 2000,
        chunkOverlap: 200,
      },
    });
  });

  it("PUT strips apiKey from ollama embedding configs", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          embedding: {
            provider: "ollama",
            baseUrl: "http://localhost:11434",
            apiKey: "not-needed",
          },
        }),
      })
    );
    expect(res.status).toBe(200);
    const patch = setSettingsDbMock.mock.calls[0][0] as {
      embedding: { apiKey?: string };
    };
    expect(patch.embedding.apiKey).toBeUndefined();
  });

  it("PUT rejects invalid embedding configurations", async () => {
    const cases = [
      JSON.stringify({ embedding: { provider: "anthropic" } }),
      JSON.stringify({ embedding: { provider: "ollama", baseUrl: "ftp://x" } }),
      JSON.stringify({ embedding: { dimensions: 0 } }),
      JSON.stringify({ embedding: { dimensions: 999999 } }),
      JSON.stringify({ embedding: { chunkSize: 10 } }),
      JSON.stringify({ embedding: { chunkSize: 999999 } }),
      JSON.stringify({ embedding: { chunkOverlap: -1 } }),
      // Overlap larger than half the chunk size
      JSON.stringify({ embedding: { chunkSize: 400, chunkOverlap: 300 } }),
      JSON.stringify({ embedding: [] }),
    ];
    for (const body of cases) {
      const res = await PUT(
        new Request("http://localhost/api/settings", { method: "PUT", body })
      );
      expect(res.status).toBe(400);
    }
  });

  it("GET reports web search provider status from env defaults", async () => {
    process.env.EXA_API_KEY = "exa-key";
    process.env.SEARXNG_BASE_URL = "http://localhost:8080";

    const res = await GET();
    const data = await res.json();

    expect(data.webSearch.providers).toEqual([
      { kind: "exa", enabled: true, ready: true, coolingDown: false },
      { kind: "firecrawl", enabled: false, ready: false, coolingDown: false },
      { kind: "searxng", enabled: true, ready: true, coolingDown: false },
    ]);
    expect(data.webSearch.chain).toEqual(["exa", "searxng"]);
  });

  it("GET reports web search status from the stored chain", async () => {
    process.env.FIRECRAWL_API_KEY = "fc-key";
    getSettingsDbMock.mockReturnValue({
      websearch: {
        providers: [
          { kind: "firecrawl", enabled: true },
          { kind: "exa", enabled: false },
        ],
      },
    });

    const res = await GET();
    const data = await res.json();

    expect(data.webSearch.providers).toEqual([
      { kind: "exa", enabled: false, ready: false, coolingDown: false },
      { kind: "firecrawl", enabled: true, ready: true, coolingDown: false },
      { kind: "searxng", enabled: false, ready: false, coolingDown: false },
    ]);
    expect(data.webSearch.chain).toEqual(["firecrawl"]);
    expect(data.store.websearch.providers).toHaveLength(2);
  });

  it("PUT persists a valid web search chain", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          websearch: {
            providers: [
              { kind: "exa", enabled: true },
              { kind: "firecrawl", enabled: false },
              {
                kind: "searxng",
                enabled: true,
                baseUrl: "http://localhost:8080",
              },
            ],
          },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith({
      websearch: {
        providers: [
          { kind: "exa", enabled: true },
          { kind: "firecrawl", enabled: false },
          { kind: "searxng", enabled: true, baseUrl: "http://localhost:8080" },
        ],
      },
    });
  });

  it("PUT drops empty credential strings from web search entries", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          websearch: {
            providers: [
              { kind: "exa", enabled: true, apiKey: "", baseUrl: "" },
            ],
          },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith({
      websearch: { providers: [{ kind: "exa", enabled: true }] },
    });
  });

  it("PUT rejects invalid web search payloads", async () => {
    const cases = [
      // Not an object
      JSON.stringify({ websearch: [] }),
      JSON.stringify({ websearch: "exa" }),
      // Missing / empty / non-array providers
      JSON.stringify({ websearch: {} }),
      JSON.stringify({ websearch: { providers: [] } }),
      JSON.stringify({ websearch: { providers: "exa" } }),
      // Unknown kind
      JSON.stringify({
        websearch: { providers: [{ kind: "google", enabled: true }] },
      }),
      // Missing enabled flag
      JSON.stringify({ websearch: { providers: [{ kind: "exa" }] } }),
      // Non-boolean enabled flag
      JSON.stringify({
        websearch: { providers: [{ kind: "exa", enabled: "yes" }] },
      }),
      // Duplicate kinds
      JSON.stringify({
        websearch: {
          providers: [
            { kind: "exa", enabled: true },
            { kind: "exa", enabled: false },
          ],
        },
      }),
      // Non-http baseUrl
      JSON.stringify({
        websearch: {
          providers: [
            { kind: "searxng", enabled: true, baseUrl: "file:///etc/passwd" },
          ],
        },
      }),
      // Non-string apiKey
      JSON.stringify({
        websearch: { providers: [{ kind: "exa", enabled: true, apiKey: 42 }] },
      }),
      // Oversized apiKey
      JSON.stringify({
        websearch: {
          providers: [
            { kind: "exa", enabled: true, apiKey: "k".repeat(2049) },
          ],
        },
      }),
    ];
    for (const body of cases) {
      const res = await PUT(
        new Request("http://localhost/api/settings", { method: "PUT", body })
      );
      expect(res.status).toBe(400);
    }
    expect(setSettingsDbMock).not.toHaveBeenCalled();
  });

  it("GET exposes stored MCP servers", async () => {
    const servers = [
      {
        id: "mcp-1",
        name: "Weather",
        transport: "http",
        enabled: true,
        url: "https://mcp.example.com/mcp",
      },
    ];
    getSettingsDbMock.mockReturnValue({ mcpServers: servers });

    const res = await GET();
    const data = await res.json();
    expect(data.store.mcpServers).toEqual(servers);
  });

  it("PUT persists a valid MCP server registry", async () => {
    const body = JSON.stringify({
      mcpServers: [
        {
          id: "mcp-1",
          name: "Weather",
          transport: "http",
          enabled: true,
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer k" },
        },
        {
          id: "mcp-2",
          name: "Files",
          transport: "stdio",
          enabled: false,
          command: "npx",
          args: ["-y", "some-mcp-server"],
          env: { TOKEN: "t" },
        },
      ],
    });
    const res = await PUT(
      new Request("http://localhost/api/settings", { method: "PUT", body })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: [
          expect.objectContaining({ id: "mcp-1", transport: "http" }),
          expect.objectContaining({ id: "mcp-2", transport: "stdio" }),
        ],
      })
    );
  });

  it("PUT accepts an empty MCP server list (clears the registry)", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({ mcpServers: [] }),
      })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServers: [] })
    );
  });

  it("PUT rejects invalid MCP server payloads", async () => {
    const cases = [
      // Not an array
      JSON.stringify({ mcpServers: { id: "mcp-1" } }),
      // Unknown transport
      JSON.stringify({
        mcpServers: [
          { id: "m", name: "x", transport: "websocket", url: "https://a.b" },
        ],
      }),
      // http without url
      JSON.stringify({
        mcpServers: [{ id: "m", name: "x", transport: "http" }],
      }),
      // non-http(s) url
      JSON.stringify({
        mcpServers: [
          { id: "m", name: "x", transport: "http", url: "file:///etc/passwd" },
        ],
      }),
      // stdio without command
      JSON.stringify({
        mcpServers: [{ id: "m", name: "x", transport: "stdio" }],
      }),
      // invalid header name
      JSON.stringify({
        mcpServers: [
          {
            id: "m",
            name: "x",
            transport: "http",
            url: "https://a.b",
            headers: { "Bad Name": "v" },
          },
        ],
      }),
      // duplicate ids
      JSON.stringify({
        mcpServers: [
          { id: "m", name: "x", transport: "stdio", command: "a" },
          { id: "m", name: "y", transport: "stdio", command: "b" },
        ],
      }),
      // missing name
      JSON.stringify({
        mcpServers: [{ id: "m", transport: "stdio", command: "a" }],
      }),
    ];
    for (const body of cases) {
      const res = await PUT(
        new Request("http://localhost/api/settings", { method: "PUT", body })
      );
      expect(res.status).toBe(400);
    }
    expect(setSettingsDbMock).not.toHaveBeenCalled();
  });

  // ── toolToggles ──────────────────────────────────────────────────

  it("GET exposes per-tool enabled/disableable flags", async () => {
    getSettingsDbMock.mockReturnValue({
      toolToggles: { disabled: ["web_search"] },
    });
    const res = await GET();
    const data = (await res.json()) as {
      tools: Array<{ name: string; enabled: boolean; disableable: boolean }>;
    };
    const byName = new Map(data.tools.map((t) => [t.name, t]));
    expect(byName.get("web_search")?.enabled).toBe(false);
    expect(byName.get("web_fetch")?.enabled).toBe(true);
    expect(byName.get("ask_user_question")?.enabled).toBe(true);
    expect(byName.get("ask_user_question")?.disableable).toBe(false);
    expect(byName.get("web_search")?.disableable).toBe(true);
  });

  it("PUT persists a valid disabled list", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          toolToggles: { disabled: ["web_search", "reminder_schedule"] },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith({
      toolToggles: { disabled: ["web_search", "reminder_schedule"] },
    });
  });

  it("PUT persists an empty disabled list (re-enable everything)", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({ toolToggles: { disabled: [] } }),
      })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith({
      toolToggles: { disabled: [] },
    });
  });

  it("PUT dedupes the disabled list before persisting", async () => {
    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          toolToggles: { disabled: ["web_search", "web_search"] },
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith({
      toolToggles: { disabled: ["web_search"] },
    });
  });

  it("PUT rejects unknown tool names, protected tools and bad shapes", async () => {
    const cases = [
      // unknown tool
      JSON.stringify({ toolToggles: { disabled: ["no_such_tool"] } }),
      // protected tool
      JSON.stringify({ toolToggles: { disabled: ["ask_user_question"] } }),
      // non-string entry
      JSON.stringify({ toolToggles: { disabled: [42] } }),
      // not an array
      JSON.stringify({ toolToggles: { disabled: "web_search" } }),
      // missing disabled field
      JSON.stringify({ toolToggles: {} }),
    ];
    for (const body of cases) {
      const res = await PUT(
        new Request("http://localhost/api/settings", { method: "PUT", body })
      );
      expect(res.status).toBe(400);
    }
    expect(setSettingsDbMock).not.toHaveBeenCalled();
  });
});
