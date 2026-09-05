import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchProviderMetadata } from "@/lib/ai/capability-detection/provider-meta";

describe("fetchProviderMetadata", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches metadata for openai-compatible provider with context_length and max_completion_tokens", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "gpt-4o",
            context_length: 128000,
            max_completion_tokens: 4096,
          },
        ],
      }),
    } as any);

    const meta = await fetchProviderMetadata({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      kind: "openai-compatible",
      modelId: "gpt-4o",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk-test" },
      })
    );
    expect(meta).toEqual({
      contextWindow: 128000,
      maxOutputTokens: 4096,
    });
  });

  it("parses capabilities.contextWindow and capabilities.maxOutput fallbacks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [
          {
            id: "custom-model",
            capabilities: {
              contextWindow: 65536,
              maxOutput: 8192,
            },
          },
        ],
      }),
    } as any);

    const meta = await fetchProviderMetadata({
      baseUrl: "https://custom.ai",
      kind: "openai-compatible",
      modelId: "custom-model",
    });

    expect(meta).toEqual({
      contextWindow: 65536,
      maxOutputTokens: 8192,
    });
  });

  it("handles ollama provider: fetches models and also /api/show when modelId is provided", async () => {
    // 1st call to /models
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ id: "llama3", context_length: 8192 }],
        }),
      } as any)
      // 2nd call to /api/show
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          capabilities: ["tools", "vision"],
        }),
      } as any);

    const meta = await fetchProviderMetadata({
      baseUrl: "http://localhost:11434/v1",
      kind: "ollama",
      modelId: "llama3",
    });

    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      "http://localhost:11434/v1/models",
      expect.any(Object)
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      "http://localhost:11434/api/show",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "llama3" }),
      })
    );

    expect(meta.contextWindow).toBe(8192);
    expect(meta.supportsToolCalls).toBe(true);
    expect(meta.inputModalities).toContain("image");
  });

  it("returns empty object on fetch failure or missing model", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const meta = await fetchProviderMetadata({
      baseUrl: "https://api.openai.com/v1",
      kind: "openai-compatible",
      modelId: "gpt-4o",
    });

    expect(meta).toEqual({});
  });
});
