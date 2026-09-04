import { describe, it, expect, vi } from "vitest";
describe("browseProviderModels", () => {
  it("parses context_length and capabilities.contextWindow via firstPositive", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m", context_length: 100, capabilities: { contextWindow: 200 } }] }) }) as any;
    const { browseProviderModels } = await import("@/lib/ai/models");
    const models = await browseProviderModels("http://x/v1", "k", "openai-compatible");
    expect(models[0].contextLength).toBe(100);
  });
});
