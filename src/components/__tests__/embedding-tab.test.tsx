import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsDialog } from "@/components/settings/settings-dialog";
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
    driver: "node:sqlite",
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
      embSource="remote"
      setEmbSource={vi.fn()}
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
      embCanForceSave={false}
      saveEmbedding={vi.fn().mockResolvedValue(undefined)}
      detectBusy={false}
      detectDimensions={vi.fn()}
      detectResult={null}
      setDetectResult={vi.fn()}
      {...overrides}
    />,
  );
}

function stubSettingsFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => snapshot,
    } as Response),
  );
}

describe("EmbeddingTab (remote OpenAI-compatible endpoint)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stubSettingsFetch();
  });

  it("asks for the endpoint fields directly instead of a provider dropdown", () => {
    renderEmbeddingTab();
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Model ID")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /embedding provider/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /endpoint type/i })).toBeNull();
  });

  it("shows write-only key fields for the remote endpoint", () => {
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

  it("explains that a legacy provider block becomes a direct endpoint", () => {
    renderEmbeddingTab({ legacyProviderName: "This server" });
    expect(screen.getByText(/Currently using provider/i)).toBeInTheDocument();
    expect(screen.getAllByText(/This server/).length).toBeGreaterThan(0);
  });

  it("offers Save without testing after a failed probe", () => {
    const saveEmbedding = vi.fn().mockResolvedValue(undefined);
    renderEmbeddingTab({ embCanForceSave: true, saveEmbedding });
    fireEvent.click(screen.getByRole("button", { name: /save without testing/i }));
    expect(saveEmbedding).toHaveBeenCalledWith(true);
  });

  it("saves through the shared handler", () => {
    const saveEmbedding = vi.fn().mockResolvedValue(undefined);
    renderEmbeddingTab({ saveEmbedding });
    fireEvent.click(screen.getByRole("button", { name: /save embedding settings/i }));
    expect(saveEmbedding).toHaveBeenCalled();
  });

  it("SettingsView prefills the endpoint from the legacy provider", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    const user = userEvent.setup();
    const embeddingTab = await waitFor(() =>
      screen.getByRole("tab", { name: "Embedding" }),
    );
    await user.click(embeddingTab);
    await waitFor(() => {
      expect(embeddingTab).toHaveAttribute("aria-selected", "true");
      const modelInput = screen.getByLabelText("Model ID");
      expect((modelInput as HTMLInputElement).value).toBe(
        "text-embedding-3-small",
      );
      const baseUrlInput = screen.getByLabelText("Base URL");
      expect((baseUrlInput as HTMLInputElement).value).toBe(
        "http://localhost:1/v1",
      );
    });
  });
});

describe("EmbeddingTab (local ONNX)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stubSettingsFetch();
  });

  it("offers a local ONNX source toggle", async () => {
    const setEmbSource = vi.fn();
    renderEmbeddingTab({ setEmbSource });
    fireEvent.click(screen.getByRole("button", { name: /local onnx/i }));
    expect(setEmbSource).toHaveBeenCalledWith("onnx");
  });

  it("lists discovered ONNX models and warns when none are found", () => {
    renderEmbeddingTab({
      embSource: "onnx",
      onnxDiscoveredModels: [],
      onnxModelPath: "",
    });
    expect(
      screen.getByText(/No ONNX embedding models discovered/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/ONNX model file/i)).toBeInTheDocument();
  });

  it("renders the discovered model selector when files exist", () => {
    renderEmbeddingTab({
      embSource: "onnx",
      onnxDiscoveredModels: [
        { filename: "bge-small-en-v1.5.onnx", sizeBytes: 60 * 1024 * 1024 },
      ],
      onnxModelPath: "bge-small-en-v1.5.onnx",
      onnxLoaded: true,
    });
    expect(screen.queryByText(/No ONNX embedding models/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Session loaded in memory/i)).toBeInTheDocument();
  });

  it("hides the remote endpoint fields while ONNX is selected", () => {
    renderEmbeddingTab({ embSource: "onnx" });
    expect(screen.queryByLabelText(/^base url$/i)).not.toBeInTheDocument();
  });
});
