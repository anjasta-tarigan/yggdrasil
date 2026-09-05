import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useRegisteredModels, getDefaultModelRef } from "@/hooks/use-registered-models";

describe("useRegisteredModels", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/providers") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            providers: [
              {
                id: "server",
                name: "This server",
                kind: "openai-compatible",
                baseUrl: "http://x",
                apiKeyConfigured: true,
                models: [
                  {
                    modelId: "m1",
                    displayName: "M1",
                    isDefault: true,
                    capabilities: {
                      contextWindow: 100,
                      maxOutputTokens: 10,
                      inputModalities: ["text"],
                      outputModalities: ["text"],
                      supportsToolCalls: true,
                      supportsReasoning: false,
                    },
                    capabilitySources: {},
                  },
                ],
              },
            ],
            embedding: null,
          }),
        });
      }
      if (url === "/api/settings") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            store: {
              websearch: { providers: [] },
              mcpServers: [],
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      });
    }) as any;
  });

  it("groups curated models by provider without per-provider fetches", async () => {
    const { result } = renderHook(() => useRegisteredModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].providerId).toBe("server");
    expect(result.current.groups[0].providerName).toBe("This server");
    expect(result.current.groups[0].kind).toBe("openai-compatible");
    expect(result.current.groups[0].models[0].displayName).toBe("M1");
    expect(result.current.groups[0].models[0].modelId).toBe("m1");
    // Ensure no per-provider calls like /api/models or /api/providers/models
    const calledUrls = (global.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(calledUrls).toContain("/api/providers");
    expect(calledUrls).not.toContain("/api/models");
    expect(calledUrls).not.toContain("/api/providers/models");
  });

  it("refetches on PROVIDERS_CHANGED_EVENT", async () => {
    const { result } = renderHook(() => useRegisteredModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    (global.fetch as any).mockClear();
    window.dispatchEvent(new Event("yggdrasil:providers-changed"));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  });

  it("returns empty groups when no providers exist", async () => {
    (global.fetch as any).mockImplementation((url: string) => {
      if (url === "/api/providers") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ providers: [], embedding: null }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ store: {} }),
      });
    });

    const { result } = renderHook(() => useRegisteredModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups).toEqual([]);
  });

  describe("getDefaultModelRef", () => {
    it("returns encoded ref for the model with isDefault: true", async () => {
      const { result } = renderHook(() => useRegisteredModels());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(getDefaultModelRef()).toBe("server::m1");
    });
  });
});
