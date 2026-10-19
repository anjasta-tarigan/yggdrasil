import { describe, it, expect, vi } from "vitest";
import { buildDurableModel } from "@/lib/ai/durable-model-step";
import type { DurableModelInit } from "@/lib/ai/durable-model";

// Mirror provider-factory.test.ts: load the real store module (which pulls in
// @/env and ./secrets) but override loadRegistry so we control the provider
// entry. See the store-import hazard: store.ts imports @/env + ./secrets, so a
// naive full mock would break env resolution.
const loadRegistryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/provider-config/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/provider-config/store")>()),
  loadRegistry: loadRegistryMock,
}));

// Mock the llama runner so no real server spawn happens.
vi.mock("@/lib/llama/runner", () => ({
  ensureGgufServerRunning: vi.fn(async () => "http://127.0.0.1:2301"),
}));

function ggufInit(over: Partial<Omit<DurableModelInit, "providerId" | "modelId" | "apiKey" | "isGguf">> = {}): DurableModelInit {
  return {
    providerId: "gguf-1",
    modelId: "m-7B.gguf",
    baseUrl: "http://127.0.0.1:2301",
    apiKey: "llamacpp",
    isGguf: true,
    ...over,
  };
}

describe("buildDurableModel", () => {
  it("uses the baseUrl RETURNED by ensureGgufServerRunning for gguf providers (not provider.baseUrl)", async () => {
    // After a foreign-port reassign the runner returns the reassigned URL
    // (port 2302) while the registry entry still carries 2301. The returned
    // DurableModelInit.baseUrl must be the reassigned one so the far side of
    // the step boundary does not rebuild a provider pointed at a foreign server.
    const { ensureGgufServerRunning } = await import("@/lib/llama/runner");
    vi.mocked(ensureGgufServerRunning).mockResolvedValueOnce("http://127.0.0.1:2302");

    loadRegistryMock.mockResolvedValue({
      version: 1,
      providers: [
        {
          id: "gguf-1",
          kind: "gguf-model",
          name: "GGUF",
          baseUrl: "http://127.0.0.1:2301",
          models: [{ modelId: "m-7B.gguf", displayName: "7B" }],
        },
      ],
    });

    const result = await buildDurableModel(ggufInit());

    expect(ensureGgufServerRunning).toHaveBeenCalledWith(
      expect.objectContaining({ id: "gguf-1", kind: "gguf-model" }),
      "m-7B.gguf"
    );
    // The SSoT is the returned baseUrl, not the pre-reassign provider.baseUrl.
    expect(result.baseUrl).toBe("http://127.0.0.1:2302");
    expect(result.isGguf).toBe(true);
    expect(result.providerId).toBe("gguf-1");
    expect(result.modelId).toBe("m-7B.gguf");
  });
});
