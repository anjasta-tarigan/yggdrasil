import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
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
        apiKeyConfigured: false,
        models: [
          {
            modelId: "llama3.2",
            displayName: "Llama 3.2",
            isDefault: true,
            capabilities: {
              contextWindow: 128000,
              maxOutputTokens: 4096,
              inputModalities: ["text"],
              outputModalities: ["text"],
              supportsToolCalls: true,
              supportsReasoning: false,
            },
            capabilitySources: {
              contextWindow: "models.dev",
            },
          },
        ],
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

  it("renders the provider list and model management", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Providers" }));

    // Built-in server card is NOT rendered in SSoT provider overhaul.
    expect(screen.queryByText("Built-in")).not.toBeInTheDocument();

    // Stored provider row renders with its kind badge and models.
    expect(await screen.findByText("Ollama (local)")).toBeInTheDocument();
    expect(screen.getByText(/^Ollama$/)).toBeInTheDocument();
    expect(screen.getByText("Llama 3.2")).toBeInTheDocument();
    expect(screen.getByText(/128k ctx/i)).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
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

  it("shows the Tools tab with tool rows; web_search carries a Configure button", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));

    // Tool list renders; the standalone web-search card is gone.
    expect(await screen.findByText("Chat tools")).toBeInTheDocument();
    expect(screen.getByText("(2)")).toBeInTheDocument();
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(
      screen.queryByText("Web search providers", { selector: "h3, p" })
    ).not.toBeInTheDocument();

    // Protected tool shows a lock with title, not a switch.
    expect(screen.getByTitle("Protected tool — always on")).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "Toggle tool send_message" })
    ).not.toBeInTheDocument();

    // web_search row has the configure button.
    expect(
      screen.getByRole("button", { name: "Configure web search providers" })
    ).toBeInTheDocument();
  });

  it("opens the web search dialog from the Configure button", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(await screen.findByText("web_search")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Configure web search providers" })
    );

    // Dialog renders provider rows, status badges and the chain.
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Web search providers")
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Exa")).toBeInTheDocument();
    expect(within(dialog).getByText("Firecrawl")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Ready").length).toBeGreaterThanOrEqual(1);
    // Chain visualization: numbered badges in fallback order.
    expect(within(dialog).getByText("1 Exa")).toBeInTheDocument();
    // Save action available inside the dialog.
    expect(
      within(dialog).getByRole("button", { name: "Save web search settings" })
    ).toBeInTheDocument();
  });

  it("filters the chat tools list", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(await screen.findByText("web_search")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Filter tools"), "send_message");

    await waitFor(() => {
      expect(screen.queryByText("web_search")).not.toBeInTheDocument();
      expect(screen.getByText("send_message")).toBeInTheDocument();
    });
  });

  it("flips a tool toggle and auto-saves the disabled set (no Save button)", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));
    await screen.findByText("web_search");

    // The Save button is gone: flipping the switch persists immediately.
    expect(
      screen.queryByRole("button", { name: "Save tool settings" })
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("switch", { name: "Toggle tool web_search" })
    );

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]).includes("/api/settings") &&
          ((c as unknown[])[1] as RequestInit | undefined)?.method === "PUT"
      );
      expect(put).toBeDefined();
      const body = JSON.parse(
        String(((put as unknown[])[1] as RequestInit).body)
      );
      expect(body.toolToggles.disabled).toEqual(["web_search"]);
    });

    // Success feedback: the saved note appears.
    expect(await screen.findByText("Saved automatically")).toBeInTheDocument();
  });

  it("rolls the toggle back and reports the error when auto-save fails", async () => {
    // GET (snapshot) succeeds; PUT (persist) fails with a server error.
    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          if (init?.method === "PUT") {
            return new Response(JSON.stringify({ error: "db locked" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify(mockSettings), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }
    );

    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));
    await screen.findByText("web_search");

    const sw = screen.getByRole("switch", { name: "Toggle tool web_search" });
    expect(sw).toHaveAttribute("data-state", "checked");
    await userEvent.click(sw);

    // The failure note appears…
    await waitFor(() => {
      expect(
        screen.getByText(
          "Couldn't save the change — check your connection and try again."
        )
      ).toBeInTheDocument();
    });
    // …and the switch rolls back to its pre-flip state.
    expect(sw).toHaveAttribute("data-state", "checked");
  });

  it("hints that a disabled built-in is served by a released MCP duplicate", async () => {
    // Layer-2 coherence: the snapshot reports web_search disabled with an
    // exposed parallel-search duplicate; the row must say the capability
    // still exists via MCP instead of silently dropping it.
    fetchMock.mockReset().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          ...mockSettings,
          tools: mockSettings.tools.map((t) =>
            t.name === "web_search" ? { ...t, enabled: false } : t
          ),
          mcpDuplicates: [
            {
              tool: "web_search",
              servers: [
                { name: "parallel-search", exposedName: "parallel-search__web_search" },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(await screen.findByText("web_search")).toBeInTheDocument();

    expect(
      screen.getByText("Disabled here, served by MCP:")
    ).toBeInTheDocument();
    expect(
      screen.getByText("parallel-search__web_search")
    ).toBeInTheDocument();
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

  it("handles adding and editing models via the ModelForm modal", async () => {
    let currentProviders: any[] = mockSettings.store.providers;
    const saveProvidersSpy = vi.spyOn(settingsLib, "saveProviders").mockImplementation(async (updated: any) => {
      currentProviders = updated;
    });
    vi.spyOn(settingsLib, "getProviders").mockImplementation(() => currentProviders);

    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Providers" }));

    // Click "Add model" button on provider card
    const addModelBtn = screen.getByRole("button", { name: "Add model to Ollama (local)" });
    await userEvent.click(addModelBtn);

    // Modal opens with Add Model title
    expect(await screen.findByText("Add Model")).toBeInTheDocument();

    // Type in Model ID
    const modelIdInput = screen.getByLabelText(/model id/i);
    await userEvent.type(modelIdInput, "deepseek-r1");

    // Save model
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    await userEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveProvidersSpy).toHaveBeenCalled();
    });

    const savedProviders = saveProvidersSpy.mock.calls[0][0];
    const p = savedProviders.find((p: any) => p.id === "p1");
    expect(p?.models.some((m: any) => m.modelId === "deepseek-r1")).toBe(true);
  });

  it("handles editing provider via the Edit Provider dialog", async () => {
    let currentProviders: any[] = mockSettings.store.providers;
    const saveProvidersSpy = vi.spyOn(settingsLib, "saveProviders").mockImplementation(async (updated: any) => {
      currentProviders = updated;
    });
    vi.spyOn(settingsLib, "getProviders").mockImplementation(() => currentProviders);

    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Providers" }));

    // Click "Edit" button on provider card
    const editProvBtn = screen.getByRole("button", { name: "Edit Ollama (local)" });
    await userEvent.click(editProvBtn);

    // Modal opens with Edit Provider title
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit Provider")).toBeInTheDocument();

    // Update name
    const nameInput = within(dialog).getByLabelText(/provider name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Ollama Server Local");
    expect(nameInput).toHaveValue("Ollama Server Local");

    // Save changes
    const saveChangesBtn = within(dialog).getByRole("button", { name: /save changes/i });
    await userEvent.click(saveChangesBtn);

    await waitFor(() => {
      expect(saveProvidersSpy).toHaveBeenCalled();
      const lastCall = saveProvidersSpy.mock.calls[saveProvidersSpy.mock.calls.length - 1][0];
      const p = lastCall.find((item: any) => item.id === "p1");
      expect(p?.name).toBe("Ollama Server Local");
    });
  });
});
