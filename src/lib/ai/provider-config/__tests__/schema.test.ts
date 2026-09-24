import { describe, it, expect } from "vitest";
import {
  ProviderEntrySchema,
  RegistryDocumentSchema,
} from "@/lib/ai/provider-config/schema";

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
    // Deep clone is structurally the same document; mutations are type-unsafe by design.
    // Deep clone stays structurally identical; mutate provider entries as records for this test.
    const doc = structuredClone(validDoc) as unknown as {
      providers: Array<Record<string, unknown> & { models: Array<Record<string, unknown>> }>;
      embedding?: Record<string, unknown>;
    };
    doc.providers.push({ id: "p2", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434", apiKeyEnv: "PROVIDER_P2_API_KEY", models: [{ modelId: "llama3", displayName: "Llama 3", isDefault: true, capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text"], outputModalities: ["text"], supportsToolCalls: null, supportsReasoning: null }, capabilitySources: {} }] });
    const r = RegistryDocumentSchema.safeParse(doc);
    expect(r.success).toBe(false);
  });
  it("rejects duplicate provider ids", () => {
    // Deep clone is structurally the same document; mutations are type-unsafe by design.
    // Deep clone stays structurally identical; mutate provider entries as records for this test.
    const doc = structuredClone(validDoc) as unknown as {
      providers: Array<Record<string, unknown> & { models: Array<Record<string, unknown>> }>;
      embedding?: Record<string, unknown>;
    };
    doc.providers.push({ ...doc.providers[0], name: "Dup" });
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects duplicate modelIds within a provider", () => {
    // Deep clone is structurally the same document; mutations are type-unsafe by design.
    // Deep clone stays structurally identical; mutate provider entries as records for this test.
    const doc = structuredClone(validDoc) as unknown as {
      providers: Array<Record<string, unknown> & { models: Array<Record<string, unknown>> }>;
      embedding?: Record<string, unknown>;
    };
    doc.providers[0].models.push({ ...doc.providers[0].models[0], isDefault: false });
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects embedding.providerId referencing a missing provider", () => {
    const doc = { ...structuredClone(validDoc), embedding: { providerId: "missing", model: "x" } } as typeof validDoc;
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
  it("rejects non-http baseUrl and over-long strings", () => {
    // Deep clone is structurally the same document; mutations are type-unsafe by design.
    // Deep clone stays structurally identical; mutate provider entries as records for this test.
    const doc = structuredClone(validDoc) as unknown as {
      providers: Array<Record<string, unknown> & { models: Array<Record<string, unknown>> }>;
      embedding?: Record<string, unknown>;
    };
    doc.providers[0].baseUrl = "ftp://x";
    expect(RegistryDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe("ProviderEntrySchema web-session preset", () => {
  const webSessionEntry = {
    id: "deepseek-web",
    kind: "web-session",
    preset: "deepseek-web",
    name: "DeepSeek Web",
    baseUrl: "https://chat.deepseek.com",
    models: [],
  };

  it("accepts web-session provider entry with preset deepseek-web", () => {
    expect(ProviderEntrySchema.safeParse(webSessionEntry).success).toBe(true);
  });

  it("rejects deepseek-web preset when kind is not web-session", () => {
    const parsed = ProviderEntrySchema.safeParse({
      ...webSessionEntry,
      kind: "openai-compatible",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["kind"] }),
        ]),
      );
    }
  });

  it("rejects unknown preset values", () => {
    expect(
      ProviderEntrySchema.safeParse({ ...webSessionEntry, preset: "other" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown kind values", () => {
    expect(
      ProviderEntrySchema.safeParse({ ...webSessionEntry, kind: "bogus" })
        .success,
    ).toBe(false);
  });
});

describe("web-session models cannot be the default", () => {
  const model = (isDefault: boolean) => ({
    modelId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    isDefault,
    capabilities: {
      contextWindow: null,
      maxOutputTokens: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalls: null,
      supportsReasoning: null,
    },
    capabilitySources: {},
  });
  const webSessionProvider = {
    id: "deepseek-web",
    kind: "web-session",
    preset: "deepseek-web",
    name: "DeepSeek Web",
    baseUrl: "https://chat.deepseek.com",
    models: [model(true)],
  };

  it("rejects a web-session provider entry whose model is the default", () => {
    const parsed = ProviderEntrySchema.safeParse(webSessionProvider);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["models"] }),
        ]),
      );
    }
  });

  it("rejects a registry document containing a default web-session model", () => {
    const parsed = RegistryDocumentSchema.safeParse({
      version: 1,
      providers: [webSessionProvider],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["providers", 0, "models", 0, "isDefault"],
          }),
        ]),
      );
    }
  });

  it("accepts a web-session model that is not the default", () => {
    expect(
      ProviderEntrySchema.safeParse({
        ...webSessionProvider,
        models: [model(false)],
      }).success,
    ).toBe(true);
  });

  it("still accepts a default model on a key-based provider", () => {
    expect(
      ProviderEntrySchema.safeParse({
        ...webSessionProvider,
        kind: "openai-compatible",
        preset: undefined,
        baseUrl: "https://api.example.com/v1",
        apiKeyEnv: "PROVIDER_EXAMPLE_API_KEY",
      }).success,
    ).toBe(true);
  });
});
