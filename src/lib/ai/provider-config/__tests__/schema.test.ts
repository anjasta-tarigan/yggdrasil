import { describe, it, expect } from "vitest";
import { RegistryDocumentSchema } from "@/lib/ai/provider-config/schema";

const validDoc = {
  version: 1,
  providers: [
    {
      id: "server", kind: "openai-compatible", name: "This server",
      baseUrl: "http://localhost:20128/v1",
      apiKeyEnv: "PROVIDER_SERVER_API_KEY", source: "env",
      models: [
        {
          modelId: "ps/poolside/laguna-s-2.1", displayName: "Laguna S 2.1",
          isDefault: true,
          capabilities: { contextWindow: 400000, maxOutputTokens: 128000, inputModalities: ["text","image"], outputModalities: ["text"], supportsToolCalls: true, supportsReasoning: false },
          capabilitySources: { contextWindow: "models.dev", inputModalities: "live-probe" },
        },
      ],
    },
  ],
  embedding: { providerId: "server", model: "text-embedding-3-small", dimensions: 768, chunkSize: 2000, chunkOverlap: 200 },
};

describe("RegistryDocumentSchema", () => {
  it("accepts a valid document", () => {
    expect(RegistryDocumentSchema.safeParse(validDoc).success).toBe(true);
  });
  it("rejects two isDefault:true models across providers", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers.push({ id: "p2", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKeyEnv: "PROVIDER_P2_API_KEY", models: [{ modelId: "llama3", displayName: "Llama 3", isDefault: true, capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text"], outputModalities: ["text"], supportsToolCalls: null, supportsReasoning: null }, capabilitySources: {} }] });
    const r = RegistryDocumentSchema.safeParse(doc);
    expect(r.success).toBe(false);
  });
  it("rejects duplicate provider ids", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers.push({ ...doc.providers[0], name: "Dup" });
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects duplicate modelIds within a provider", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers[0].models.push({ ...doc.providers[0].models[0], isDefault: false });
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects embedding.providerId referencing a missing provider", () => {
    const doc = { ...structuredClone(validDoc), embedding: { providerId: "missing", model: "x" } } as any;
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects non-http baseUrl and over-long strings", () => {
    const doc = structuredClone(validDoc) as any;
    doc.providers[0].baseUrl = "ftp://x";
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
});
