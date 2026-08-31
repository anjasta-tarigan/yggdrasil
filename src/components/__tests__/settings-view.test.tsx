import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "@/components/settings-view";
import * as settingsLib from "@/lib/settings";

// vitest runs without globals:true, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

const mockSettings = {
  ai: { baseUrl: "http://localhost:11434", modelId: "llama3", apiKeyConfigured: true },
  embedding: {
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "nomic-embed-text",
    apiKeyConfigured: false,
    dimensions: 768,
    chunkSize: 2000,
    chunkOverlap: 200,
    fallback: "local",
  },
  database: {
    engine: "SQLite",
    driver: "better-sqlite3",
    features: ["WAL", "FTS5"],
    path: "/tmp/yggdrasil.db",
    sizeBytes: 64 * 1024 * 1024,
    chatCount: 12,
    messageCount: 3456,
    memories: { episodic: 100, semantic: 40, working: 5 },
    queue: { pending: 3, completed: 500, failed: 2 },
    cognitive: {
      daemonRunning: true,
      queueRunnerRunning: true,
      relations: 512,
      unembedded: { episodic: 2, semantic: 0 },
      lastRuns: [{ type: "sleep_consolidation", at: "2025-06-01T11:00:00.000Z" }],
      lastFailure: null,
    },
  },
  tools: [
    {
      name: "web_search",
      description: "Search the web",
      configured: true,
      requires: null,
      enabled: true,
      disableable: true,
    },
    {
      name: "send_message",
      description: "Protected tool",
      configured: true,
      requires: null,
      enabled: true,
      disableable: false,
    },
  ],
  webSearch: {
    providers: [
      { kind: "exa", enabled: true, ready: true, coolingDown: false },
      { kind: "firecrawl", enabled: false, ready: false, coolingDown: false },
      { kind: "searxng", enabled: false, ready: false, coolingDown: false },
    ],
    chain: ["exa"],
  },
  about: { name: "Yggdrasil", version: "0.1.0", stack: "Next.js + SQLite" },
  store: {
    providers: [
      {
        id: "p1",
        name: "Ollama (local)",
        kind: "ollama",
        baseUrl: "http://localhost:11434",
      },
    ],
    embedding: { provider: "ollama", model: "nomic-embed-text" },
  },
};

const fetchMock = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    void init;
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/settings") {
      return new Response(JSON.stringify(mockSettings), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }
);

// The view reads the hydrated local settings cache at mount via lazy
// initializers; stub the module so no test depends on localStorage state.
vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof settingsLib>();
  return {
    ...actual,
    getProviders: vi.fn(() => mockSettings.store.providers),
    getEmbeddingSettings: vi.fn(() => ({
      provider: "ollama",
      baseUrl: "http://localhost:11434",
      apiKey: "",
      model: "nomic-embed-text",
      dimensions: 768,
      chunkSize: 2000,
      chunkOverlap: 200,
    })),
    getWebSearchProviders: vi.fn(() => [
      { kind: "exa", enabled: true },
      { kind: "firecrawl", enabled: false },
      { kind: "searxng", enabled: false },
    ]),
  };
});

describe("SettingsView", () => {
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          return new Response(JSON.stringify(mockSettings), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  it("shows the General tab by default with the theme card", async () => {
    render(<SettingsView onBack={() => {}} />);

    // Theme card appears on the default tab.
    expect(await screen.findByText("Appearance")).toBeInTheDocument();

    // All six tabs are present in the bar.
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Embedding" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Database" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tools" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "About" })).toBeInTheDocument();

    // Intro paragraph matches the active tab.
    expect(
      screen.getByText(/Theme preference and general assistant behavior/)
    ).toBeInTheDocument();
  });

  it("renders the built-in provider card and provider list", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Providers" }));

    // Built-in server card with badge.
    expect(await screen.findByText("This server")).toBeInTheDocument();
    expect(screen.getByText("Built-in")).toBeInTheDocument();
    // The built-in card's base URL row (exact match, not the provider row's).
    expect(screen.getAllByText("http://localhost:11434").length).toBeGreaterThanOrEqual(1);

    // Stored provider row renders with its kind badge.
    expect(screen.getByText("Ollama (local)")).toBeInTheDocument();
    expect(screen.getByText(/^Ollama$/)).toBeInTheDocument();
  });

  it("switches to the Database tab and renders grouped cards with tiles", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Database" }));

    // Three grouped cards.
    expect(await screen.findByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("Cognitive loop")).toBeInTheDocument();
    expect(screen.getByText("Maintenance")).toBeInTheDocument();

    // Stat tiles: chats / messages / memories total / queue pending.
    const tileValues = await waitFor(() => {
      const values = Array.from(
        document.querySelectorAll("p.tabular-nums")
      ).map((el) => el.textContent);
      expect(values).toEqual(["12", "3,456", "145", "3"]);
      return values;
    });
    expect(tileValues).toBeDefined();

    // Cognitive rows with status dots.
    expect(screen.getByText("Queue runner")).toBeInTheDocument();
    expect(screen.getByText("Cron daemon")).toBeInTheDocument();
    // Both services are running in the fixture.
    expect(screen.getAllByText("running").length).toBe(2);
  });

  it("queues a maintenance pass from the Database tab", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Database" }));

    await userEvent.click(screen.getByRole("button", { name: "Run dream cycle" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes("/api/maintenance") &&
          String(c[0]) !== "/api/maintenance/backfill"
      );
      expect(call).toBeDefined();
    });
  });

  it("renders web search providers and chat tools with toggles on the Tools tab", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));

    // Web search cards + live status badges.
    expect(await screen.findByText("Web search providers")).toBeInTheDocument();
    expect(screen.getByText("Exa")).toBeInTheDocument();
    expect(screen.getByText("Firecrawl")).toBeInTheDocument();
    // "Ready" appears on the Exa provider badge and the web_search tool badge.
    expect(screen.getAllByText("Ready").length).toBeGreaterThanOrEqual(2);

    // Chat tools with ready badge and protected hint.
    expect(screen.getByText("Chat tools")).toBeInTheDocument();
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(
      screen.getByText("This tool is protected and cannot be disabled.")
    ).toBeInTheDocument();
  });

  it("flips a tool toggle and persists via save", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));
    await screen.findByText("web_search");

    // Flip the web_search toggle off (optimistic).
    await userEvent.click(
      screen.getByRole("switch", { name: "Toggle tool web_search" })
    );
    expect(screen.getByText("Hidden from the model.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save tool settings" }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/settings")
      );
      expect(put).toBeDefined();
    });
  });

  it("renders the About card with a version badge", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "About" }));

    expect(await screen.findByText("Yggdrasil")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
    expect(screen.getByText("Next.js + SQLite")).toBeInTheDocument();
  });

  it("shows a load error banner when the settings fetch fails", async () => {
    fetchMock.mockReset().mockImplementation(async () => {
      return new Response("server error", { status: 500 });
    });

    render(<SettingsView onBack={() => {}} />);

    expect(
      await screen.findByText(/Could not load server configuration/)
    ).toBeInTheDocument();
  });
});
