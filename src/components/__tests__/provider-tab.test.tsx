import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ProviderTab } from "@/components/settings/tabs";
import { getProviderCardTrigger } from "@/test-utils/provider-card";
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
    expandCard("P1");
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
    expandCard("P1");
    expect(screen.getByText(/no models added/i)).toBeInTheDocument();
    const addModelBtn = screen.getByRole("button", { name: /add model to p1/i });
    expect(addModelBtn).toBeInTheDocument();
    fireEvent.click(addModelBtn);
    expect(addModel).toHaveBeenCalledWith("p1");
  });

  it("starts every provider card collapsed", () => {
    const providers = [
      {
        id: "p1",
        name: "P1",
        kind: "ollama",
        baseUrl: "http://a",
        apiKeyConfigured: false,
        models: [{ modelId: "a1", displayName: "A1" }],
      },
      {
        id: "p2",
        name: "P2",
        kind: "ollama",
        baseUrl: "http://b",
        apiKeyConfigured: false,
        models: [{ modelId: "b1", displayName: "B1" }],
      },
    ] as ProviderConfig[];
    render(<ProviderTab providers={providers} {...handlers()} />);

    // The default state is collapsed, so a long provider list stays scannable.
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);
    expect(screen.queryByText("A1")).not.toBeInTheDocument();
    expect(screen.queryByText("B1")).not.toBeInTheDocument();
  });

  it("keeps a provider's identity and actions reachable while collapsed", () => {
    const providers = [
      {
        id: "p1",
        name: "Big Provider",
        kind: "openai-compatible",
        baseUrl: "http://y",
        apiKeyConfigured: true,
        models: [
          { modelId: "m1", displayName: "M1" },
          { modelId: "m2", displayName: "M2" },
        ],
      } as ProviderConfig,
    ];
    render(<ProviderTab providers={providers} {...handlers()} />);

    // Collapsed by default: the models list is gone, but nothing you need in
    // order to act on the provider is.
    expect(screen.queryByText("M1")).not.toBeInTheDocument();
    expect(screen.getByText("Big Provider")).toBeInTheDocument();
    expect(screen.getByText("http://y")).toBeInTheDocument();
    // The model count is the signal for whether expanding is worth it.
    expect(screen.getByText("2 models")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit big provider/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove big provider/i })).toBeInTheDocument();

    const trigger = expandCard("Big Provider");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("M1")).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("M1")).not.toBeInTheDocument();
  });

  it("uses the singular 'model' label for a single-model provider", () => {
    const providers = [
      {
        id: "p1",
        name: "Solo",
        kind: "ollama",
        baseUrl: "http://a",
        apiKeyConfigured: false,
        models: [{ modelId: "a1", displayName: "A1" }],
      } as ProviderConfig,
    ];
    render(<ProviderTab providers={providers} {...handlers()} />);
    expect(screen.getByText("1 model")).toBeInTheDocument();
  });

  it("collapses each provider independently", () => {
    const providers = [
      {
        id: "p1",
        name: "P1",
        kind: "ollama",
        baseUrl: "http://a",
        apiKeyConfigured: false,
        models: [{ modelId: "a1", displayName: "A1" }],
      },
      {
        id: "p2",
        name: "P2",
        kind: "ollama",
        baseUrl: "http://b",
        apiKeyConfigured: false,
        models: [{ modelId: "b1", displayName: "B1" }],
      },
    ] as ProviderConfig[];
    render(<ProviderTab providers={providers} {...handlers()} />);

    // Expanding one card must not expand its siblings.
    expandCard("P1");

    expect(screen.getByText("A1")).toBeInTheDocument();
    expect(screen.queryByText("B1")).not.toBeInTheDocument();
  });

  it("excludes web-session providers from the API provider list (Spec §10.1)", () => {
    const providers = [
      {
        id: "p1",
        name: "Normal Provider",
        kind: "ollama",
        baseUrl: "http://a",
        apiKeyConfigured: false,
        models: [],
      },
      {
        id: "deepseek-web",
        name: "DeepSeek Web",
        kind: "web-session",
        baseUrl: "https://chat.deepseek.com",
        apiKeyConfigured: false,
        models: [],
      },
    ] as ProviderConfig[];

    render(<ProviderTab providers={providers} {...handlers()} />);

    // The key-based provider still renders as a provider card.
    expect(screen.getByText("Normal Provider")).toBeInTheDocument();
    // The browser-session adapter is listed only in its own experimental
    // section — never as an API provider with an Edit/Remove affordance.
    expect(screen.queryByText("DeepSeek Web")).not.toBeInTheDocument();
  });
});

/**
 * Click a provider card's collapsible header, and hand back the trigger so
 * callers can assert on its aria-expanded afterwards.
 */
function expandCard(providerName: string): HTMLElement {
  const trigger = getProviderCardTrigger(providerName);
  fireEvent.click(trigger);
  return trigger;
}

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
