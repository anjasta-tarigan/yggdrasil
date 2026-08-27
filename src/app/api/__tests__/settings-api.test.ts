import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, PUT } from "../settings/route";

const getSettingsDbMock = vi.fn();
const setSettingsDbMock = vi.fn();

vi.mock("@/lib/settings-service", () => ({
  getSettingsDb: (...args: unknown[]) => getSettingsDbMock(...args),
  setSettingsDb: (...args: unknown[]) => setSettingsDbMock(...args),
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
  chatTools: {},
}));

vi.mock("@/lib/ai/provider", () => ({
  defaultModelId: "test-model",
}));

describe("Settings API Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsDbMock.mockReturnValue({});
  });

  it("GET returns snapshot with an empty store by default", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.store).toEqual({ providers: [], embedding: {} });
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
});
