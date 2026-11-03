import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderConfig } from "@/lib/settings";
import { ProviderEditDialog } from "../provider-edit-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const openAiProvider = {
  id: "p-openai",
  kind: "openai-compatible",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKeyConfigured: true,
  models: [],
} as unknown as ProviderConfig;

const ollamaProvider = {
  id: "p-ollama",
  kind: "ollama",
  name: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  models: [],
} as unknown as ProviderConfig;

function renderDialog(
  overrides: Partial<Parameters<typeof ProviderEditDialog>[0]> = {},
) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    provider: openAiProvider,
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    clearKey: false,
    error: null as string | null,
    busy: false,
    onNameChange: vi.fn(),
    onBaseUrlChange: vi.fn(),
    onApiKeyChange: vi.fn(),
    onClearKeyChange: vi.fn(),
    onCancel: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  render(<ProviderEditDialog {...props} />);
  return props;
}

describe("ProviderEditDialog", () => {
  it("edits the name and base URL through callbacks", () => {
    const props = renderDialog();

    fireEvent.change(screen.getByLabelText("Provider Name"), {
      target: { value: "OpenAI (prod)" },
    });
    expect(props.onNameChange).toHaveBeenCalledWith("OpenAI (prod)");

    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://proxy.example/v1" },
    });
    expect(props.onBaseUrlChange).toHaveBeenCalledWith("https://proxy.example/v1");
  });

  it("shows the API key field only for OpenAI-compatible providers", () => {
    renderDialog();

    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    expect(screen.getByText("Clear configured key")).toBeInTheDocument();
  });

  it("hides the API key field for other provider kinds", () => {
    renderDialog({ provider: ollamaProvider, name: "Ollama" });

    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });

  it("clears the typed key when the clear toggle is engaged", () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Clear configured key" }));

    expect(props.onClearKeyChange).toHaveBeenCalledWith(true);
    expect(props.onApiKeyChange).toHaveBeenCalledWith("");
  });

  it("offers to keep the existing key when clearing is pending", () => {
    const props = renderDialog({ clearKey: true });

    expect(screen.getByLabelText("API Key")).toBeDisabled();
    const keep = screen.getByRole("button", { name: "Keep existing key" });
    fireEvent.click(keep);

    expect(props.onClearKeyChange).toHaveBeenCalledWith(false);
    expect(props.onApiKeyChange).not.toHaveBeenCalled();
  });

  it("submits through onSave", () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(props.onSave).toHaveBeenCalledTimes(1);
  });

  it("blocks saving when the base URL is blank", () => {
    renderDialog({ baseUrl: "   " });

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("locks both actions while a save is in flight", () => {
    renderDialog({ busy: true });

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("closes through onCancel without discarding provider state", () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it("surfaces a save error", () => {
    renderDialog({ error: "Base URL is required" });

    expect(screen.getByText("Base URL is required")).toBeInTheDocument();
  });
});
