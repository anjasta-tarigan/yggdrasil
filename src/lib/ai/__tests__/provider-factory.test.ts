import { describe, it, expect, vi, beforeEach } from "vitest";
import { chatModelForEntry } from "@/lib/ai/provider";

describe("chatModelForEntry", () => {
  it("builds an ollama provider without requiring an api key", () => {
    const entry = { id: "ollama-1", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKeyEnv: undefined, models: [] } as any;
    const model = chatModelForEntry("llama3", entry);
    expect(model).toBeDefined();
  });
  it("throws a clear error when baseUrl is missing", () => {
    const entry = { id: "bad", kind: "openai-compatible", name: "Bad", baseUrl: "", models: [] } as any;
    expect(() => chatModelForEntry("x", entry)).toThrow(/baseUrl/i);
  });
});
