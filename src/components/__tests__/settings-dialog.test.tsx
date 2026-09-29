import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as settingsLib from "@/lib/settings";
import { SettingsDialog } from "@/components/settings/settings-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
  database: { path: "/tmp/test.db", size: 1024, stats: { chats: 1, memories: 0, cache: 0 } },
  webSearch: { providers: [] },
  features: { chatTools: [], customTools: [] },
  modelRegistry: { providers: [], models: [] },
  jobs: { lastRun: null, status: "idle" },
  persona: { name: "Yggdrasil", instructions: "You are a helpful assistant." },
  ui: { theme: "system", fontSize: "normal" },
  maintenance: { active: false },
};

// Stub the settings module so no test depends on localStorage state.
vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof settingsLib>();
  return {
    ...actual,
    getProviders: vi.fn(() => []),
    getEmbeddingSettings: vi.fn(() => mockSettings.embedding),
    getWebSearchProviders: vi.fn(() =>
      (mockSettings.webSearch.providers ?? []).map((p: { kind: string; enabled: boolean }) => p)
    ),
  };
});

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

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
    fetchMock.mockReset().mockImplementation(
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
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <SettingsDialog open={false} onOpenChange={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the Settings dialog when open", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);

    // The outer dialog has an accessible name "Settings" (sr-only title).
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(dialog).toBeInTheDocument();

    // Tab navigation is present.
    expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Persona" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument();
  });

  it("calls onOpenChange(false) when the close button is clicked", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog open={true} onOpenChange={onOpenChange} />);

    await screen.findByRole("dialog", { name: "Settings" });

    // Radix Dialog's close button is present (showCloseButton=true).
    const closeBtn = screen.getByRole("button", { name: "Close" });
    await userEvent.click(closeBtn);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the dimmed overlay behind the modal", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    await screen.findByRole("dialog", { name: "Settings" });

    // The overlay has the expected backdrop styling class.
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveClass("bg-black/40");
  });

  it("shows all eight tab icons in the navigation rail", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    await screen.findByRole("dialog", { name: "Settings" });

    // All eight tabs are present.
    const tabs = [
      "General",
      "Persona",
      "Providers",
      "Embedding",
      "Reranker",
      "Database",
      "Tools",
      "About",
    ];
    for (const tab of tabs) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
  });

  it("switches tabs and shows the corresponding content", async () => {
    render(<SettingsDialog open={true} onOpenChange={() => {}} />);
    await screen.findByRole("dialog", { name: "Settings" });

    // Default tab is General.
    expect(await screen.findByText("Appearance")).toBeInTheDocument();

    // Switch to Embedding tab.
    await userEvent.click(screen.getByRole("tab", { name: "Embedding" }));
    expect(screen.getByRole("tab", { name: "Embedding" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("does not render the Dialog in the DOM when open changes to false", async () => {
    const { rerender } = render(
      <SettingsDialog open={true} onOpenChange={() => {}} />
    );
    await screen.findByRole("dialog", { name: "Settings" });

    // Re-render with closed state.
    rerender(<SettingsDialog open={false} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
