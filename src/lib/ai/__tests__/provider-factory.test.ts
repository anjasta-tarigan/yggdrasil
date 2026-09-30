import { describe, it, expect, vi } from "vitest";
import { chatModelForEntry, getDefaultModel } from "@/lib/ai/provider";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";

// B4 demotes a web-session default on every write, so the state below can no
// longer be persisted through `saveRegistry`. The factory's guard is still the
// last line of defence for a default that arrives out of band, so inject it at
// the registry read instead of through the store.
const loadRegistryMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/provider-config/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/provider-config/store")>()),
  loadRegistry: loadRegistryMock,
}));

// Mock the llama runner so no real server spawn happens during factory tests.
vi.mock("@/lib/llama/runner", () => ({
  ensureGgufServerRunning: vi.fn(async () => "http://127.0.0.1:2301"),
}));

describe("chatModelForEntry", () => {
  it("builds an ollama provider without requiring an api key", async () => {
    const entry = { id: "ollama-1", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKeyEnv: undefined, models: [] } as { id: string; kind: "ollama"; name: string; baseUrl: string; apiKeyEnv?: string; models: never[] };
    const model = await chatModelForEntry("llama3", entry);
    expect(model).toBeDefined();
    expect(model.provider).toBe("ollama.chat");
  });
  it("uses entry.id for openai-compatible providers instead of hardcoded vllm", async () => {
    const entry = { id: "my-cloud-provider", kind: "openai-compatible", name: "Cloud", baseUrl: "https://api.cloud.com/v1", apiKeyEnv: "KEY", models: [] } as { id: string; kind: "openai-compatible"; name: string; baseUrl: string; apiKeyEnv?: string; models: never[] };
    const model = await chatModelForEntry("meta-llama/Llama-3", entry, "sk-test");
    expect(model).toBeDefined();
    expect(model.provider).toBe("my-cloud-provider.chat");
  });
  it("throws a clear error when baseUrl is missing", async () => {
    const entry = { id: "bad", kind: "openai-compatible", name: "Bad", baseUrl: "", models: [] } as { id: string; kind: "openai-compatible"; name: string; baseUrl: string; apiKeyEnv?: string; models: never[] };
    await expect(chatModelForEntry("x", entry)).rejects.toThrow(/baseUrl/i);
  });
  it("builds a gguf-model provider as keyless OpenAI-compatible with /v1 suffix", async () => {
    const entry = {
      id: "gguf-1", kind: "gguf-model", name: "GGUF",
      baseUrl: "http://127.0.0.1:2301", models: [],
    } as unknown as Parameters<typeof chatModelForEntry>[1];
    const model = await chatModelForEntry("m-7B.gguf", entry);
    expect(model).toBeDefined();
    expect(model.provider).toBe("gguf-1.chat");
  });
  it("starts the gguf server before building the model", async () => {
    const { ensureGgufServerRunning } = await import("@/lib/llama/runner");
    const mocked = vi.mocked(ensureGgufServerRunning);
    mocked.mockResolvedValueOnce("http://127.0.0.1:2301");
    const entry = {
      id: "gguf-1", kind: "gguf-model", name: "GGUF",
      baseUrl: "http://127.0.0.1:2301", models: [],
    } as unknown as Parameters<typeof chatModelForEntry>[1];
    await chatModelForEntry("m-7B.gguf", entry);
    expect(mocked).toHaveBeenCalledWith(entry, "m-7B.gguf");
  });
});

describe("getDefaultModel", () => {
  function webSessionDefaultDocument(): RegistryDocument {
    return {
      version: 1,
      providers: [
        {
          id: "deepseek-web",
          kind: "web-session",
          preset: "deepseek-web",
          name: "DeepSeek Web",
          baseUrl: "https://chat.deepseek.com",
          models: [
            {
              modelId: "deepseek-chat",
              displayName: "DeepSeek Chat",
              isDefault: true,
              capabilities: {
                contextWindow: null,
                maxOutputTokens: null,
                inputModalities: ["text"],
                outputModalities: ["text"],
                supportsToolCalls: null,
                supportsReasoning: null,
              },
              capabilitySources: {},
            },
          ],
        },
      ],
    };
  }

  it("refuses a web-session default instead of building a sessionless model", async () => {
    // Background jobs (reflect_turn, sleep_consolidation) call this with no
    // session; building the model would only defer the failure to generation.
    loadRegistryMock.mockResolvedValue(webSessionDefaultDocument());

    await expect(getDefaultModel()).rejects.toThrow(
      /web provider.*background jobs cannot use/i
    );
  });
});
