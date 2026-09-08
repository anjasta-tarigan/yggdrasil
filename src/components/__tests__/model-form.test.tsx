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

  it("triggers debounced auto-detection when modelId is typed in new model mode", async () => {
    const mockDetect = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
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

    // Should display matched catalog badge
    await waitFor(() => {
      expect(screen.getByText(/catalog: claude-3-5-sonnet/i)).toBeInTheDocument();
      expect(screen.getByText(/200k ctx/i)).toBeInTheDocument();
      expect(screen.getByText(/8k out/i)).toBeInTheDocument();
    });
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
