import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "@/components/settings-view";
import { EmbeddingTab } from "@/components/settings/tabs";

// The settings snapshot fetch — the shape served by GET /api/settings.
const snapshot = {
  embedding: {
    providerId: "server",
    apiKeyConfigured: true,
    model: "text-embedding-3-small",
    dimensions: 1536,
    chunkSize: 2000,
    chunkOverlap: 200,
  },
  webSearch: { providers: [], chain: [] },
  database: {
    engine: "SQLite",
    driver: "better-sqlite3",
    features: ["WAL"],
    path: "/tmp/x.db",
    sizeBytes: 1,
    chatCount: 0,
    messageCount: 0,
    memories: { episodic: 0, semantic: 0, working: 0 },
    queue: { pending: 0, completed: 0, failed: 0 },
  },
  tools: [],
  mcpDuplicates: [],
  about: { name: "Yggdrasil", version: "0.1.0", stack: "test" },
  store: {
    providers: [
      {
        id: "server",
        kind: "openai-compatible",
        name: "This server",
        baseUrl: "http://localhost:1/v1",
        apiKeyConfigured: true,
        models: [],
      },
    ],
    websearch: {},
    mcpServers: [],
  },
};

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...actual,
    hydrateSettings: vi.fn().mockResolvedValue(undefined),
    getProviders: vi.fn(
      () =>
        snapshot.store.providers as unknown as ReturnType<
          typeof actual.getProviders
        >,
    ),
    getEmbeddingSettings: vi.fn(() => ({
      providerId: "server",
      model: "text-embedding-3-small",
      dimensions: 1536,
    })),
    getWebSearchProviders: vi.fn(() => []),
    getMcpServers: vi.fn(() => []),
    saveProviders: vi.fn().mockResolvedValue(undefined),
    saveEmbeddingSettings: vi.fn().mockResolvedValue(undefined),
    saveWebSearchProviders: vi.fn().mockResolvedValue(undefined),
  };
});

function renderEmbeddingTab(overrides: Record<string, unknown> = {}) {
  return render(
    <EmbeddingTab
      providers={[{ id: "server", name: "This server", kind: "openai-compatible" }]}
      embProviderId={null}
      setEmbProviderId={vi.fn()}
      embBaseUrl=""
      setEmbBaseUrl={vi.fn()}
      embApiKey=""
      setEmbApiKey={vi.fn()}
      embApiKeyConfigured={false}
      clearEmbApiKey={vi.fn()}
      embModel=""
      setEmbModel={vi.fn()}
      embDimensions={null}
      setEmbDimensions={vi.fn()}
      embeddingSaved={false}
      embSaveError={null}
      saveEmbedding={vi.fn().mockResolvedValue(undefined)}
      detectBusy={false}
      detectDimensions={vi.fn()}
      detectResult={null}
      setDetectResult={vi.fn()}
      ollamaDetectBusy={false}
      detectOllamaUrl={vi.fn()}
      ollamaModels={[]}
      {...overrides}
    />
  );
}

describe("EmbeddingTab (registry providerId shape)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => snapshot,
      } as Response),
    );
  });

  it("offers registry providers plus a custom-endpoint option", async () => {
    renderEmbeddingTab();
    // The closed trigger shows the custom-endpoint value (providerId null
    // maps to __custom__), and opening the select lists the registry ids.
    await waitFor(() =>
      expect(
        screen.getAllByText("Custom endpoint (standalone)").length,
      ).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText("This server")).toBeInTheDocument());
  });

  it("hides the standalone endpoint fields while a registry provider is selected", () => {
    renderEmbeddingTab({ embProviderId: "server" });
    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/sk-…/)).not.toBeInTheDocument();
    // The provider-referenced model field IS present (it has the id).
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
  });

  it("shows write-only key fields for the custom endpoint", () => {
    renderEmbeddingTab();
    expect(screen.getAllByText(/write-only/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/never sent back to the browser/i).length,
    ).toBeGreaterThan(0);
  });

  it("reveals the configured-key placeholder and Clear action when a key is stored", () => {
    renderEmbeddingTab({ embApiKeyConfigured: true });
    expect(
      screen.getByPlaceholderText(/configured — type to replace/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  it("SettingsView hydrates the embedding form from the top-level embedding block", async () => {
    render(<SettingsView onBack={vi.fn()} />);
    const user = userEvent.setup();
    const embeddingTab = await waitFor(() =>
      screen.getByRole("tab", { name: "Embedding" }),
    );
    await user.click(embeddingTab);
    // The registry provider id (not the legacy provider kind) is the
    // selected value; its model carried over from the snapshot.
    await waitFor(() => {
      expect(embeddingTab).toHaveAttribute("aria-selected", "true");
      const modelInput = screen.getByLabelText("Model");
      expect((modelInput as HTMLInputElement).value).toBe(
        "text-embedding-3-small",
      );
    });
  });
});
