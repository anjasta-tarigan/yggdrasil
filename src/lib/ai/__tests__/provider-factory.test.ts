import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import { chatModelForEntry, getDefaultModel } from "@/lib/ai/provider";
import {
  saveRegistry,
  setProviderConfigPathsForTest,
} from "@/lib/ai/provider-config/store";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";
import {
  cleanupTestProviderRegistry,
  createTestProviderRegistryDir,
} from "@/test-utils/provider-registry";

describe("chatModelForEntry", () => {
  it("builds an ollama provider without requiring an api key", () => {
    const entry = { id: "ollama-1", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKeyEnv: undefined, models: [] } as { id: string; kind: "ollama"; name: string; baseUrl: string; apiKeyEnv?: string; models: never[] };
    const model = chatModelForEntry("llama3", entry);
    expect(model).toBeDefined();
    expect(model.provider).toBe("ollama.chat");
  });
  it("uses entry.id for openai-compatible providers instead of hardcoded vllm", () => {
    const entry = { id: "my-cloud-provider", kind: "openai-compatible", name: "Cloud", baseUrl: "https://api.cloud.com/v1", apiKeyEnv: "KEY", models: [] } as { id: string; kind: "openai-compatible"; name: string; baseUrl: string; apiKeyEnv?: string; models: never[] };
    const model = chatModelForEntry("meta-llama/Llama-3", entry, "sk-test");
    expect(model).toBeDefined();
    expect(model.provider).toBe("my-cloud-provider.chat");
  });
  it("throws a clear error when baseUrl is missing", () => {
    const entry = { id: "bad", kind: "openai-compatible", name: "Bad", baseUrl: "", models: [] } as { id: string; kind: "openai-compatible"; name: string; baseUrl: string; apiKeyEnv?: string; models: never[] };
    expect(() => chatModelForEntry("x", entry)).toThrow(/baseUrl/i);
  });
});

describe("getDefaultModel", () => {
  const registryDir = createTestProviderRegistryDir("ygg-default-model");

  afterAll(async () => {
    await cleanupTestProviderRegistry(registryDir);
  });

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
    setProviderConfigPathsForTest(registryDir);
    await fs.mkdir(registryDir, { recursive: true });
    await saveRegistry(webSessionDefaultDocument());

    await expect(getDefaultModel()).rejects.toThrow(
      /web provider.*background jobs cannot use/i
    );
  });
});
