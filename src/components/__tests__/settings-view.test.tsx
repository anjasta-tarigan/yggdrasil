import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "@/components/settings-view";
import * as settingsLib from "@/lib/settings";

/** Loose test fixture type — satisfies the structural shape the tests read
    without requiring all ProviderEntryView fields. */
type TestProvider = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  models: Array<{
    modelId: string;
    displayName?: string;
    isDefault?: boolean;
    capabilities?: Record<string, unknown>;
    capabilitySources?: Record<string, string>;
  }>;
};

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
  reranker: {
    enabled: true,
    available: true,
    loaded: false,
    modelPath: "/app/data/models/reranker/bge-reranker-v2-m3-int8.onnx",
    canonicalPath: "/app/data/models/reranker/bge-reranker-v2-m3-int8.onnx",
    mode: "standby" as const,
    discoveredModels: [
      {
        filename: "bge-reranker-v2-m3-int8.onnx",
        sizeBytes: 544 * 1024 * 1024,
      },
    ],
  },
  about: { name: "Yggdrasil", version: "0.1.0", stack: "Next.js + SQLite" },
  store: {
    reranker: {
      enabled: true,
      selectedModel: "bge-reranker-v2-m3-int8.onnx",
    },
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

    // All eight tabs are present in the bar.
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Persona" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Embedding" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Reranker" })).toBeInTheDocument();
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
    fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/custom-tools") {
        return new Response(JSON.stringify({ tools: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
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
    let currentProviders: TestProvider[] = mockSettings.store.providers;
    const saveProvidersSpy = vi.spyOn(settingsLib, "saveProviders").mockImplementation(async (updated) => {
      currentProviders = updated as TestProvider[];
    });
    vi.spyOn(settingsLib, "getProviders").mockImplementation(() => currentProviders as unknown as ReturnType<typeof settingsLib.getProviders>);

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
    const p = savedProviders.find((p) => p.id === "p1");
    expect(p?.models?.some((m) => m.modelId === "deepseek-r1")).toBe(true);
  });

  it("the first model added to an empty registry becomes default automatically (spec §5.3)", async () => {
    // Empty registry: a provider exists but holds no models. Both the
    // mount-time snapshot fetch AND the settings-lib cache must agree,
    // or the fetch effect overwrites the empty fixture.
    const emptyRegistry = {
      ...mockSettings,
      store: {
        ...mockSettings.store,
        providers: [
          {
            id: "p1",
            name: "Ollama (local)",
            kind: "ollama",
            baseUrl: "http://localhost:11434",
            apiKeyConfigured: false,
            models: [],
          },
        ],
      },
    };
    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          return new Response(JSON.stringify(emptyRegistry), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }
    );
    let currentProviders: TestProvider[] = emptyRegistry.store.providers;
    const saveProvidersSpy = vi.spyOn(settingsLib, "saveProviders").mockImplementation(async (updated) => {
      currentProviders = updated as TestProvider[];
    });
    vi.spyOn(settingsLib, "getProviders").mockImplementation(() => currentProviders as unknown as ReturnType<typeof settingsLib.getProviders>);

    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");
    await userEvent.click(screen.getByRole("tab", { name: "Providers" }));

    await userEvent.click(screen.getByRole("button", { name: "Add model to Ollama (local)" }));
    expect(await screen.findByText("Add Model")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/model id/i), "first-model");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(saveProvidersSpy).toHaveBeenCalled());
    const saved = saveProvidersSpy.mock.calls.at(-1)![0] as TestProvider[];
    const added = saved
      .find((p: TestProvider) => p.id === "p1")
      ?.models.find((m: TestProvider["models"][number]) => m.modelId === "first-model");
    expect(added?.isDefault).toBe(true);
  });

  it("handles editing provider via the Edit Provider dialog", async () => {
    let currentProviders: TestProvider[] = mockSettings.store.providers;
    const saveProvidersSpy = vi.spyOn(settingsLib, "saveProviders").mockImplementation(async (updated) => {
      currentProviders = updated as TestProvider[];
    });
    vi.spyOn(settingsLib, "getProviders").mockImplementation(() => currentProviders as unknown as ReturnType<typeof settingsLib.getProviders>);

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
      const p = lastCall.find((item) => item.id === "p1");
      expect(p?.name).toBe("Ollama Server Local");
    });
  });

  // ── Embedding model-change confirmation dialog ──────────────────────

  it("shows the rebuild dialog when the server reports a model change", async () => {
    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        void init;
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          return new Response(
            JSON.stringify({ ...mockSettings, embeddingModelChanged: "text-embedding-3-large" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      }
    );

    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Rebuild embeddings?")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/You changed the embedding model to "text-embedding-3-large"/)
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Rebuild now" })).toBeInTheDocument();
  });

  it("does not show the dialog when embeddingModelChanged is null", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dismisses the dialog and calls the dismiss endpoint", async () => {
    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        void init;
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          return new Response(
            JSON.stringify({ ...mockSettings, embeddingModelChanged: "new-model" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.pathname === "/api/maintenance/dismiss-model-change") {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }
    );

    render(<SettingsView onBack={() => {}} />);
    const dialog = await screen.findByRole("dialog");

    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    const dismissCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).includes("/api/maintenance/dismiss-model-change")
    );
    expect(dismissCall).toBeDefined();
    expect(dismissCall?.[1]?.method).toBe("POST");
  });

  it("rebuilds embeddings on confirmation and shows the success note", async () => {
    let rebuildTriggered = false;
    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          // After the rebuild, the re-fetch should NOT surface the flag.
          const settingsResponse = rebuildTriggered
            ? { ...mockSettings, embeddingModelChanged: null }
            : { ...mockSettings, embeddingModelChanged: "new-model" };
          return new Response(JSON.stringify(settingsResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/maintenance/rebuild-index") {
          rebuildTriggered = true;
          return new Response(
            JSON.stringify({
              success: true,
              nulledCount: 150,
              embeddedCount: 148,
              remaining: 2,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      }
    );

    render(<SettingsView onBack={() => {}} />);
    const dialog = await screen.findByRole("dialog");

    await userEvent.click(within(dialog).getByRole("button", { name: "Rebuild now" }));

    await waitFor(() => {
      const rebuildCall = fetchMock.mock.calls.find(
        (c) => String(c[0]).includes("/api/maintenance/rebuild-index")
      );
      expect(rebuildCall).toBeDefined();
      expect(rebuildCall?.[1]?.method).toBe("POST");
    });

    // Dialog should be gone after a successful rebuild.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Navigate to the Database tab to see the maintenance note.
    await userEvent.click(screen.getByRole("tab", { name: "Database" }));
    await waitFor(() => {
      expect(
        screen.getByText(/Rebuilt index: re-embedded 148 memories/)
      ).toBeInTheDocument();
    });
  });

  it("renders a real-time progress bar when rebuild is in progress", async () => {
    let resolveRebuild: (val: Response) => void;
    const rebuildPromise = new Promise<Response>((resolve) => {
      resolveRebuild = resolve;
    });

    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          return new Response(
            JSON.stringify({ ...mockSettings, embeddingModelChanged: "new-model" }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.pathname === "/api/maintenance/rebuild-index") {
          return rebuildPromise;
        }
        return new Response("not found", { status: 404 });
      }
    );

    render(<SettingsView onBack={() => {}} />);
    const dialog = await screen.findByRole("dialog");

    await userEvent.click(within(dialog).getByRole("button", { name: "Rebuild now" }));

    // While in-flight, the progress container and progress bar must be visible
    expect(await screen.findByTestId("rebuild-progress")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText(/Re-embedding memories…/)).toBeInTheDocument();

    // Resolve the rebuild
    resolveRebuild!(
      new Response(
        JSON.stringify({
          success: true,
          nulledCount: 10,
          embeddedCount: 10,
          remaining: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("triggers the rebuild dialog immediately when save button is clicked with a model change", async () => {
    fetchMock.mockReset().mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/api/settings") {
          if (init?.method === "PUT") {
            return new Response(
              JSON.stringify({ success: true, embeddingModelChanged: "text-embedding-3-large" }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
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

    // Navigate to Embedding tab
    await userEvent.click(screen.getByRole("tab", { name: "Embedding" }));

    // Click Save button
    const saveButton = screen.getByRole("button", { name: /save embedding settings/i });
    await userEvent.click(saveButton);

    // Verify warning dialog pops up immediately
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Rebuild embeddings?")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/You changed the embedding model to "text-embedding-3-large"/)
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Rebuild now" })).toBeInTheDocument();
  });

  it("switches to the Reranker tab and renders reranker cards", async () => {
    render(<SettingsView onBack={() => {}} />);
    await screen.findByText("Appearance");

    await userEvent.click(screen.getByRole("tab", { name: "Reranker" }));

    expect(await screen.findByText("Neural reranking")).toBeInTheDocument();
    expect(screen.getByText("Discovered models")).toBeInTheDocument();
    expect(screen.getByText("Status & diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Standby")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: /toggle neural reranker/i })
    ).toBeInTheDocument();
  });
});
