import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectCapabilities } from "@/lib/ai/capability-detection/index";
import * as catalogModule from "@/lib/ai/capability-detection/catalog";
import * as providerMetaModule from "@/lib/ai/capability-detection/provider-meta";
import * as probesModule from "@/lib/ai/capability-detection/probes";
import * as storeModule from "@/lib/ai/provider-config/store";
import { POST } from "@/app/api/providers/detect/route";

describe("detectCapabilities orchestrator", () => {
  const dummyProvider = {
    id: "test-provider",
    kind: "openai-compatible" as const,
    name: "Test Provider",
    baseUrl: "https://api.test.com/v1",
    apiKeyEnv: "PROVIDER_TEST_API_KEY",
    models: [
      {
        modelId: "existing-model",
        displayName: "Existing Model",
        isDefault: false,
        capabilities: {
          contextWindow: 64000,
          maxOutputTokens: 4096,
          inputModalities: ["text" as const, "video" as const],
          outputModalities: ["text" as const],
          supportsToolCalls: true,
          supportsReasoning: false,
        },
        capabilitySources: {
          contextWindow: "user" as const,
          inputModalities: "user" as const,
        },
      },
    ],
  };

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(storeModule, "getProviderById").mockImplementation(async (id: string) => {
      if (id === "test-provider") return dummyProvider as any;
      return null;
    });

    vi.spyOn(storeModule, "resolveApiKey").mockImplementation(async () => "test-api-key");

    vi.spyOn(catalogModule, "getModelsDevCatalog").mockResolvedValue({
      models: [
        {
          id: "gpt-4o",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsToolCalls: true,
          supportsReasoning: false,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
        },
        {
          id: "text-only-model",
          contextWindow: 32000,
          maxOutputTokens: 2048,
          supportsToolCalls: false,
          supportsReasoning: false,
          inputModalities: ["text"],
          outputModalities: ["text"],
        },
      ],
    });
  });

  it("throws if provider is not found", async () => {
    const { ProviderNotFoundError } = await import(
      "@/lib/ai/capability-detection/index"
    );
    await expect(
      detectCapabilities({ providerId: "unknown-provider", modelId: "gpt-4o", force: true })
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
  });

  it("Layer precedence: catalog provides base, providerMeta overrides limits", async () => {
    vi.spyOn(providerMetaModule, "fetchProviderMetadata").mockResolvedValue({
      contextWindow: 200000,
      maxOutputTokens: 8192,
    });

    const result = await detectCapabilities({
      providerId: "test-provider",
      modelId: "gpt-4o",
      force: true,
    });

    expect(result.capabilities.contextWindow).toBe(200000);
    expect(result.capabilitySources.contextWindow).toBe("provider-metadata");

    expect(result.capabilities.maxOutputTokens).toBe(8192);
    expect(result.capabilitySources.maxOutputTokens).toBe("provider-metadata");

    expect(result.capabilities.supportsToolCalls).toBe(true);
    expect(result.capabilitySources.supportsToolCalls).toBe("models.dev");

    expect(result.matchedCatalogId).toBe("gpt-4o");
  });

  it("detection cache does not serve entries past the 60s TTL (expired entries are evicted, not just skipped)", async () => {
    vi.spyOn(providerMetaModule, "fetchProviderMetadata").mockResolvedValue({});
    vi.useFakeTimers();
    try {
      // Prime the cache for gpt-4o.
      await detectCapabilities({
        providerId: "test-provider",
        modelId: "gpt-4o",
        force: true,
      });
      const catalogSpy = catalogModule.getModelsDevCatalog as ReturnType<typeof vi.spyOn>;
      catalogSpy.mockClear();

      // Within the window: served from cache — no catalog fetch.
      await detectCapabilities({ providerId: "test-provider", modelId: "gpt-4o" });
      expect(catalogSpy).not.toHaveBeenCalled();

      // Past the window: a non-forced call re-runs the pipeline.
      vi.advanceTimersByTime(61_000);
      await detectCapabilities({ providerId: "test-provider", modelId: "gpt-4o" });
      expect(catalogSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Rate limit: second call within 60s without force: true returns cached result without re-probing/re-fetching", async () => {
    const fetchMetaSpy = vi
      .spyOn(providerMetaModule, "fetchProviderMetadata")
      .mockResolvedValue({ contextWindow: 100000 });

    const result1 = await detectCapabilities({
      providerId: "test-provider",
      modelId: "cached-model-test",
      force: true,
    });

    expect(fetchMetaSpy).toHaveBeenCalledTimes(1);

    const result2 = await detectCapabilities({
      providerId: "test-provider",
      modelId: "cached-model-test",
      force: false,
    });

    expect(fetchMetaSpy).toHaveBeenCalledTimes(1);
    expect(result2).toEqual(result1);
  });

  it("force: true bypasses 60s rate limit", async () => {
    const fetchMetaSpy = vi
      .spyOn(providerMetaModule, "fetchProviderMetadata")
      .mockResolvedValue({ contextWindow: 100000 });

    await detectCapabilities({
      providerId: "test-provider",
      modelId: "force-model-test",
      force: true,
    });

    expect(fetchMetaSpy).toHaveBeenCalledTimes(1);

    await detectCapabilities({
      providerId: "test-provider",
      modelId: "force-model-test",
      force: true,
    });

    expect(fetchMetaSpy).toHaveBeenCalledTimes(2);
  });

  it("User override stickiness: existing model with capabilitySources[field] === 'user' preserves stored value across detection run", async () => {
    vi.spyOn(providerMetaModule, "fetchProviderMetadata").mockResolvedValue({
      contextWindow: 100000,
    });

    const result = await detectCapabilities({
      providerId: "test-provider",
      modelId: "existing-model",
      force: true,
    });

    // contextWindow had "user" source with 64000
    expect(result.capabilities.contextWindow).toBe(64000);
    expect(result.capabilitySources.contextWindow).toBe("user");

    // inputModalities had "user" source with ["text", "video"]
    expect(result.capabilities.inputModalities).toEqual(["text", "video"]);
    expect(result.capabilitySources.inputModalities).toBe("user");
  });

  it("Max 3 probes per run: executes probes when modalities not definitively known", async () => {
    vi.spyOn(providerMetaModule, "fetchProviderMetadata").mockResolvedValue({});
    const probeSpy = vi.spyOn(probesModule, "probeModality").mockImplementation(async (opts) => {
      if (opts.modality === "image") {
        return { supported: true, errorClass: "unknown" };
      }
      return { supported: false, errorClass: "modality_not_supported" };
    });

    const result = await detectCapabilities({
      providerId: "test-provider",
      modelId: "unknown-new-model",
      force: true,
    });

    expect(probeSpy).toHaveBeenCalledTimes(3);
    expect(result.capabilities.inputModalities).toContain("text");
    expect(result.capabilities.inputModalities).toContain("image");
    expect(result.capabilities.inputModalities).not.toContain("audio");
    expect(result.capabilities.inputModalities).not.toContain("video");
    expect(result.capabilitySources.inputModalities).toBe("live-probe");
  });
});

describe("/api/providers/detect route POST handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(storeModule, "getProviderById").mockImplementation(async (id: string) => {
      if (id === "p1") {
        return {
          id: "p1",
          kind: "openai-compatible",
          name: "P1",
          baseUrl: "https://api.p1.com",
          models: [],
        } as any;
      }
      return null;
    });
    vi.spyOn(storeModule, "resolveApiKey").mockResolvedValue("key");
    vi.spyOn(catalogModule, "getModelsDevCatalog").mockResolvedValue({
      models: [
        {
          id: "m1",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          supportsToolCalls: true,
          supportsReasoning: false,
        },
      ],
    });
    vi.spyOn(providerMetaModule, "fetchProviderMetadata").mockResolvedValue({});
  });

  it("returns 200 with detection result on valid payload", async () => {
    const req = new Request("http://localhost/api/providers/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "p1", modelId: "m1", force: true }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities).toBeDefined();
    expect(data.capabilities.contextWindow).toBe(128000);
    expect(data.capabilitySources).toBeDefined();
    expect(data.matchedCatalogId).toBe("m1");
  });

  it("returns 400 on malformed JSON", async () => {
    const req = new Request("http://localhost/api/providers/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ malformed json",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Invalid JSON body");
  });

  it("returns 400 on missing or invalid providerId/modelId fields", async () => {
    const req1 = new Request("http://localhost/api/providers/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "p1" }),
    });
    const res1 = await POST(req1);
    expect(res1.status).toBe(400);

    const req2 = new Request("http://localhost/api/providers/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "m1" }),
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(400);
  });

  it("returns 404 on unknown provider", async () => {
    const req = new Request("http://localhost/api/providers/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "p-unknown", modelId: "m1" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('Provider "p-unknown" not found');
  });
});
