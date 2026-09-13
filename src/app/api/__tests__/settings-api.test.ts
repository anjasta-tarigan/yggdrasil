import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, PUT } from "../settings/route";
import {
  setProviderConfigPathsForTest,
  saveRegistry,
  loadRegistry,
} from "@/lib/ai/provider-config/store";
import {
  readSecretsMap,
  writeSecretsEnv,
} from "@/lib/ai/provider-config/secrets";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";

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

describe("Settings API Handler", () => {
  const ENV_KEYS = ["EXA_API_KEY", "FIRECRAWL_API_KEY", "SEARXNG_BASE_URL"];
  const originalEnv: Record<string, string | undefined> = {};
  let dataDir: string;

  function seedDoc(): RegistryDocument {
    return structuredClone({
      version: 1,
      providers: [
        {
          id: "server",
          kind: "openai-compatible",
          name: "This server",
          baseUrl: "http://localhost:20128/v1",
          apiKeyEnv: "PROVIDER_SERVER_API_KEY",
          models: [
            {
              modelId: "m1",
              displayName: "m1",
              isDefault: true,
              capabilities: {
                contextWindow: null,
                maxOutputTokens: null,
                inputModalities: ["text"] as const,
                outputModalities: ["text"] as const,
                supportsToolCalls: null,
                supportsReasoning: null,
              },
              capabilitySources: {},
            },
          ],
        },
        {
          id: "ollama-1",
          kind: "ollama",
          name: "Ollama",
          baseUrl: "http://localhost:11434",
          models: [],
        },
      ],
      embedding: {
        providerId: "server",
        model: "text-embedding-3-small",
        dimensions: 768,
        chunkSize: 2000,
        chunkOverlap: 200,
      },
    });
  }

  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    getSettingsDbMock.mockReturnValue({});
    // Deterministic web search chain defaults for every test.
    delete process.env.EXA_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.SEARXNG_BASE_URL;

    dataDir = await mkdtemp(join(tmpdir(), "ygg-set-"));
    setProviderConfigPathsForTest(dataDir);
    await saveRegistry(seedDoc());
    await writeSecretsEnv(
      new Map([["PROVIDER_SERVER_API_KEY", "sk-settings-test"]]),
    );
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("GET returns snapshot with an empty store by default", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ai).toBeUndefined();
    expect(data.store.providers).toHaveLength(2);
    expect(data.store.websearch).toEqual({});
    expect(data.store.mcpServers).toEqual([]);
    expect(data.embedding.model).toBe("text-embedding-3-small");
    expect(JSON.stringify(data)).not.toContain("sk-settings-test");
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
    const res = await GET();
    const data = await res.json();
    expect(data.store.providers[0].apiKeyConfigured).toBe(true);
    expect("apiKey" in data.store.providers[0]).toBe(false);
    expect(data.embedding.providerId).toBe("server");
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
            apiKey: "sk-put-test",
          },
        ],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).not.toHaveBeenCalled();

    const doc = await loadRegistry();
    const custom = doc.providers.find((p) => p.id === "custom-1");
    expect(custom).toBeDefined();
    expect(custom?.apiKeyEnv).toBe("PROVIDER_CUSTOM_1_API_KEY");
    expect(custom && "apiKey" in custom).toBe(false);

    const secrets = await readSecretsMap();
    expect(secrets.get("PROVIDER_CUSTOM_1_API_KEY")).toBe("sk-put-test");
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
            apiKey: "ignored",
          },
        ],
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);

    const doc = await loadRegistry();
    const ollama = doc.providers.find((p) => p.id === "ollama-1");
    expect(ollama).toBeDefined();
    expect(ollama?.apiKeyEnv).toBeUndefined();
    expect(ollama && "apiKey" in ollama).toBe(false);

    const secrets = await readSecretsMap();
    expect(
      Array.from(secrets.keys()).some((k) => k.includes("OLLAMA")),
    ).toBe(false);
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
            providerId: null,
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

    const doc = await loadRegistry();
    expect(doc.embedding?.providerId).toBe("ollama-1");
  });

  it("PUT rejects invalid embedding configurations", async () => {
    const cases = [
      // Overlap larger than half the chunk size
      JSON.stringify({ embedding: { chunkSize: 400, chunkOverlap: 300 } }),
      JSON.stringify({ embedding: { dimensions: 0 } }),
      JSON.stringify({ embedding: { dimensions: 999999 } }),
      JSON.stringify({ embedding: { providerId: "missing" } }),
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
        body: JSON.stringify({
          toolToggles: { disabled: [] },
        }),
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

  describe("corrupt provider registry", () => {
    beforeEach(async () => {
      // Overwrite the seeded registry with garbage: spec §6 requires a
      // corrupt file to fail fast with the named path — never to be
      // silently treated as an empty registry or replaced on the next PUT.
      const { writeFile } = await import("node:fs/promises");
      const { REGISTRY_PATH } = await import(
        "@/lib/ai/provider-config/store"
      );
      await writeFile(REGISTRY_PATH, "{ not json", "utf8");
    });

    it("GET surfaces the failure instead of an empty provider list", async () => {
      const res = await GET();
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toMatch(/provider registry/i);
      // The corrupt file is still intact — nothing overwrote it.
      const { readFile } = await import("node:fs/promises");
      const { REGISTRY_PATH } = await import(
        "@/lib/ai/provider-config/store"
      );
      await expect(readFile(REGISTRY_PATH, "utf8")).resolves.toBe(
        "{ not json",
      );
    });

    it("PUT fails fast instead of seeding a fresh empty registry", async () => {
      const res = await PUT(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          body: JSON.stringify({ websearch: { providers: [] } }),
        }),
      );
      // The websearch payload is invalid on its own, but the point is the
      // registry must not be silently replaced before that check runs.
      // A corrupt registry surfaces as a 500 naming the file.
      expect(res.status).not.toBe(200);
      const { readFile } = await import("node:fs/promises");
      const { REGISTRY_PATH } = await import(
        "@/lib/ai/provider-config/store"
      );
      await expect(readFile(REGISTRY_PATH, "utf8")).resolves.toBe(
        "{ not json",
      );
    });
  });

  // ── Embedding model-change detection ────────────────────────────────

  describe("embedding model-change detection", () => {
    it("GET surfaces embeddingModelChanged when the flag is set in the store", async () => {
      // The flag is set by PUT when a model change is detected; GET simply
      // surfaces whatever is stored under the EMBEDDING_MODEL_CHANGED_KEY.
      getSettingsDbMock.mockReturnValue({
        embedding_model: "text-embedding-3-small",
        embedding_model_changed: "text-embedding-3-large",
      });

      await saveRegistry({
        ...seedDoc(),
        embedding: {
          providerId: "server",
          model: "text-embedding-3-large",
          dimensions: 3072,
          chunkSize: 2000,
          chunkOverlap: 200,
        },
      });

      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      // The new model name is surfaced as the flag value.
      expect(data.embeddingModelChanged).toBe("text-embedding-3-large");
    });

    it("GET returns null when the stored model matches the live model", async () => {
      getSettingsDbMock.mockReturnValue({
        embedding_model: "text-embedding-3-small",
      });

      // seedDoc already has embedding.model = "text-embedding-3-small"
      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.embeddingModelChanged).toBeNull();
    });

    it("GET returns null when the stored model has not been set yet", async () => {
      getSettingsDbMock.mockReturnValue({});

      const res = await GET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.embeddingModelChanged).toBeNull();
    });

    it("PUT detects a model change and writes both the new model tag and the flag", async () => {
      getSettingsDbMock.mockReturnValue({
        embedding_model: "text-embedding-3-small",
      });

      const res = await PUT(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            embedding: {
              providerId: "server",
              model: "text-embedding-3-large",
              dimensions: 3072,
              chunkSize: 2000,
              chunkOverlap: 200,
            },
          }),
        })
      );
      expect(res.status).toBe(200);

      // The settings store should receive both the model tag and the flag.
      expect(setSettingsDbMock).toHaveBeenCalledWith({
        embedding_model: "text-embedding-3-large",
        embedding_model_changed: "text-embedding-3-large",
      });
    });

    it("PUT does not set the flag when the model is unchanged", async () => {
      getSettingsDbMock.mockReturnValue({
        embedding_model: "text-embedding-3-small",
      });

      const res = await PUT(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            embedding: {
              providerId: "server",
              model: "text-embedding-3-small",
              dimensions: 768,
              chunkSize: 2000,
              chunkOverlap: 200,
            },
          }),
        })
      );
      expect(res.status).toBe(200);

      // The flag and model key should NOT be written when the model is the same.
      const calls = setSettingsDbMock.mock.calls;
      expect(calls).toHaveLength(0);
    });

    it("PUT stores the model tag even when only the provider changes (model resolves differently)", async () => {
      getSettingsDbMock.mockReturnValue({
        embedding_model: "text-embedding-3-small",
      });

      // Switch from server provider to ollama: the model resolves to
      // "nomic-embed-text" (the ollama default) which differs.
      await saveRegistry({
        ...seedDoc(),
        embedding: {
          providerId: "ollama-1",
          dimensions: 768,
          chunkSize: 2000,
          chunkOverlap: 200,
        },
      });

      const res = await PUT(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            embedding: {
              providerId: "ollama-1",
              dimensions: 768,
              chunkSize: 2000,
              chunkOverlap: 200,
            },
          }),
        })
      );
      expect(res.status).toBe(200);

      expect(setSettingsDbMock).toHaveBeenCalledWith({
        embedding_model: "nomic-embed-text",
        embedding_model_changed: "nomic-embed-text",
      });
    });
  });
});
