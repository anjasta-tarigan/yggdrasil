import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ProviderTab } from "@/components/settings/tabs";
import type { ProviderConfig } from "@/lib/settings";
import type { ProviderTabProps } from "@/components/settings/tabs";

afterEach(() => {
  cleanup();
});

describe("ProviderTab", () => {
  it("does not render a Built-in card", () => {
    render(
      <ProviderTab
        providers={[
          {
            id: "server",
            name: "This server",
            kind: "openai-compatible",
            baseUrl: "http://x",
            apiKeyConfigured: true,
            models: [],
          } as ProviderConfig,
        ]}
        {...handlers()}
      />
    );
    expect(screen.queryByText(/built-in/i)).not.toBeInTheDocument();
  });

  it("renders an Edit button per provider card", () => {
    const editProvider = vi.fn();
    render(
      <ProviderTab
        providers={[
          {
            id: "p1",
            name: "P1",
            kind: "ollama",
            baseUrl: "http://y",
            apiKeyConfigured: false,
            models: [],
          } as ProviderConfig,
        ]}
        {...handlers({ editProvider })}
      />
    );
    const editBtn = screen.getByRole("button", { name: /edit p1/i });
    expect(editBtn).toBeInTheDocument();
    fireEvent.click(editBtn);
    expect(editProvider).toHaveBeenCalledTimes(1);
  });

  it("renders per-provider models with capability chips", () => {
    const providers = [
      {
        id: "p1",
        name: "P1",
        kind: "openai-compatible",
        baseUrl: "http://y",
        apiKeyConfigured: true,
        models: [
          {
            modelId: "m1",
            displayName: "M1",
            isDefault: true,
            capabilities: {
              contextWindow: 400000,
              maxOutputTokens: 128000,
              inputModalities: ["text", "image"],
              outputModalities: ["text"],
              supportsToolCalls: true,
              supportsReasoning: false,
            },
            capabilitySources: { contextWindow: "models.dev" },
          },
        ],
      } as ProviderConfig,
    ];
    render(<ProviderTab providers={providers} {...handlers()} />);
    expect(screen.getByText("M1")).toBeInTheDocument();
    expect(screen.getByText(/400k/i)).toBeInTheDocument();
    expect(screen.getByText(/default/i)).toBeInTheDocument();
  });

  it("renders 'No models added' when models array is empty and handles Add model button", () => {
    const addModel = vi.fn();
    const providers = [
      {
        id: "p1",
        name: "P1",
        kind: "ollama",
        baseUrl: "http://localhost:11434",
        apiKeyConfigured: false,
        models: [],
      } as ProviderConfig,
    ];
    render(<ProviderTab providers={providers} {...handlers({ addModel })} />);
    expect(screen.getByText(/no models added/i)).toBeInTheDocument();
    const addModelBtn = screen.getByRole("button", { name: /add model to p1/i });
    expect(addModelBtn).toBeInTheDocument();
    fireEvent.click(addModelBtn);
    expect(addModel).toHaveBeenCalledWith("p1");
  });
});

function handlers(overrides: Partial<ProviderTabProps> = {}) {
  return {
    addOllama: vi.fn(),
    ollamaBusy: false,
    ollamaError: null,
    openaiFormOpen: false,
    setOpenaiFormOpen: vi.fn(),
    oaName: "",
    setOaName: vi.fn(),
    oaBaseUrl: "",
    setOaBaseUrl: vi.fn(),
    oaApiKey: "",
    setOaApiKey: vi.fn(),
    oaBusy: false,
    oaError: null,
    setOaError: vi.fn(),
    addOpenaiProvider: vi.fn(),
    deleteProvider: vi.fn(),
    editProvider: vi.fn(),
    addModel: vi.fn(),
    editModel: vi.fn(),
    deleteModel: vi.fn(),
    ...overrides,
  } satisfies Partial<ProviderTabProps>;
}
