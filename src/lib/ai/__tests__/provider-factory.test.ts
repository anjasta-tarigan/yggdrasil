import { describe, it, expect } from "vitest";
import { chatModelForEntry } from "@/lib/ai/provider";

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
