import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ModelForm } from "@/components/settings/model-form";
import type { ModelEntry } from "@/lib/ai/provider-config/schema";

describe("ModelForm", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders with prefilled model data and displays capability chips", () => {
    const existingModel: ModelEntry = {
      modelId: "gpt-4o",
      displayName: "GPT-4o Omnimodel",
      isDefault: true,
      capabilities: {
        contextWindow: 128000,
        maxOutputTokens: 16384,
        inputModalities: ["text", "image", "audio"],
        outputModalities: ["text", "audio"],
        supportsToolCalls: true,
        supportsReasoning: false,
      },
      capabilitySources: {
        contextWindow: "models.dev",
        supportsToolCalls: "models.dev",
      },
    };

    render(
      <ModelForm
        open={true}
        providerId="prov-openai"
        model={existingModel}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByDisplayValue("gpt-4o")).toBeInTheDocument();
    expect(screen.getByDisplayValue("GPT-4o Omnimodel")).toBeInTheDocument();
    expect(screen.getByText(/128k ctx/i)).toBeInTheDocument();
    expect(screen.getByText(/16k out/i)).toBeInTheDocument();
    expect(screen.getByText(/tools/i)).toBeInTheDocument();
  });

  it("does not auto-detect when editing an existing model", async () => {
    // Editing must never re-run detection: it would overwrite the user's
    // curated capabilities and their sources before they can save.
    const mockDetect = vi.fn();
    global.fetch = mockDetect as unknown as typeof fetch;
    const existingModel: ModelEntry = {
      modelId: "gpt-4o",
      displayName: "GPT-4o",
      isDefault: false,
      capabilities: {
        contextWindow: 128000,
        maxOutputTokens: 16384,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalls: true,
        supportsReasoning: false,
      },
      capabilitySources: { contextWindow: "user" },
    };

    render(
      <ModelForm
        open={true}
        providerId="prov-openai"
        model={existingModel}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // Editing the model id is exactly the action that used to arm the debounce.
    fireEvent.change(screen.getByDisplayValue("gpt-4o"), {
      target: { value: "gpt-4o-mini" },
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(mockDetect).not.toHaveBeenCalled();
  });

  it("triggers debounced auto-detection when modelId is typed in new model mode", async () => {
    const mockDetect = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        matchedCatalogName: "Claude 3.5 Sonnet",
        capabilities: {
          contextWindow: 200000,
          maxOutputTokens: 8192,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          supportsToolCalls: true,
          supportsReasoning: true,
        },
        capabilitySources: {
          contextWindow: "models.dev",
          maxOutputTokens: "models.dev",
          supportsToolCalls: "models.dev",
          supportsReasoning: "models.dev",
        },
        matchedCatalogId: "claude-3-5-sonnet",
      }),
    });
    global.fetch = mockDetect as unknown as typeof fetch;

    render(
      <ModelForm
        open={true}
        providerId="prov-anthropic"
        model={null}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const modelIdInput = screen.getByLabelText(/model id/i);
    fireEvent.change(modelIdInput, { target: { value: "claude-3-5-sonnet-20241022" } });

    await waitFor(
      () => {
        expect(mockDetect).toHaveBeenCalledWith("/api/providers/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: "prov-anthropic",
            modelId: "claude-3-5-sonnet-20241022",
            force: false,
          }),
        });
      },
      { timeout: 1500 }
    );

    // Should display the catalog badge and friendly display name.
    await waitFor(() => {
      expect(screen.getByText(/catalog: claude-3-5-sonnet/i)).toBeInTheDocument();
      expect(screen.getByDisplayValue("Claude 3.5 Sonnet")).toBeInTheDocument();
      expect(screen.getByText(/200k ctx/i)).toBeInTheDocument();
      expect(screen.getByText(/8k out/i)).toBeInTheDocument();
    });
  });

  it("preserves a manually edited display name after catalog detection", async () => {
    const mockDetect = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ matchedCatalogName: "Catalog Name", capabilities: {}, capabilitySources: {} }),
    });
    global.fetch = mockDetect as unknown as typeof fetch;

    const handleSave = vi.fn();
    render(
      <ModelForm
        open={true}
        providerId="prov-1"
        model={null}
        onSave={handleSave}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText(/model id/i), { target: { value: "gpt-4o" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "My preferred name" } });
    await waitFor(() => expect(mockDetect).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(handleSave.mock.calls[0][0].displayName).toBe("My preferred name");
  });

  it("applies manual overrides and marks source as user on save", async () => {
    const handleSave = vi.fn();
    const handleClose = vi.fn();

    render(
      <ModelForm
        open={true}
        providerId="prov-1"
        model={null}
        onSave={handleSave}
        onClose={handleClose}
      />
    );

    const modelIdInput = screen.getByLabelText(/model id/i);
    fireEvent.change(modelIdInput, { target: { value: "custom-llama" } });

    // Override context window
    const ctxInput = screen.getByLabelText(/context window/i);
    fireEvent.change(ctxInput, { target: { value: "32768" } });

    // Submit form
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    fireEvent.click(saveBtn);

    expect(handleSave).toHaveBeenCalledTimes(1);
    const savedEntry = handleSave.mock.calls[0][0];
    expect(savedEntry.modelId).toBe("custom-llama");
    expect(savedEntry.displayName).toBe("custom-llama"); // falls back to modelId
    expect(savedEntry.capabilities.contextWindow).toBe(32768);
    expect(savedEntry.capabilitySources.contextWindow).toBe("user");
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it("skips detection entirely for a web-session provider and saves unknown capabilities", async () => {
    // Detection would probe `https://chat.deepseek.com`, outside the adapter's
    // pinned endpoint allowlist (Spec §7.1); manual entry must not trigger it.
    const mockDetect = vi.fn();
    global.fetch = mockDetect as unknown as typeof fetch;
    const handleSave = vi.fn();

    render(
      <ModelForm
        open={true}
        providerId="deepseek-web"
        providerKind="web-session"
        model={null}
        onSave={handleSave}
        onClose={vi.fn()}
      />
    );

    // The Detect control is present but inert for this provider.
    expect(
      screen.getByRole("button", { name: /re-detect capabilities/i })
    ).toBeDisabled();
    expect(
      screen.getByText(/Capability detection is unavailable for this provider/i)
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/model id/i), {
      target: { value: "deepseek-chat" },
    });
    // The default toggle is disabled: web models are never auto-defaulted.
    expect(screen.getByRole("switch", { name: /default model/i })).toBeDisabled();

    // Give the 600ms debounce a chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(mockDetect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const savedEntry = handleSave.mock.calls[0][0];
    expect(savedEntry.modelId).toBe("deepseek-chat");
    expect(savedEntry.isDefault).toBe(false);
    expect(savedEntry.capabilities.contextWindow).toBeNull();
    expect(savedEntry.capabilities.supportsToolCalls).toBeNull();
  });

  it("keeps the Re-detect button enabled during the 60s cap (force bypasses it)", async () => {
    // Spec §4: a manual Re-detect always opens a fresh probing budget —
    // the countdown is informational, never a button disable.
    const mockDetect = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        capabilities: {
          contextWindow: 100,
          maxOutputTokens: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalls: null,
          supportsReasoning: null,
        },
        capabilitySources: { contextWindow: "models.dev" },
      }),
    });
    global.fetch = mockDetect as unknown as typeof fetch;

    render(
      <ModelForm
        open={true}
        providerId="prov-1"
        model={null}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const modelIdInput = screen.getByLabelText(/model id/i);
    fireEvent.change(modelIdInput, { target: { value: "gpt-x" } });

    // Wait for the debounced auto-detect to fire and the countdown to arm.
    await waitFor(
      () => expect(mockDetect).toHaveBeenCalled(),
      { timeout: 1500 },
    );

    // The Detect button must remain clickable — force:true goes through.
    const detectBtn = screen.getByRole("button", {
      name: /re-detect capabilities/i,
    });
    expect((detectBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(detectBtn);
    await waitFor(() => {
      expect(mockDetect).toHaveBeenLastCalledWith("/api/providers/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "prov-1", modelId: "gpt-x", force: true }),
      });
    });
  });
});
