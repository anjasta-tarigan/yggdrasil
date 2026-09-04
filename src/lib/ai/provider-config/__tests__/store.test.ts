import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";

let dataDir: string;

describe("provider-config store", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ygg-store-"));
    process.env.YGGDRASIL_PROVIDER_CONFIG_DIR = dataDir;
  });
  afterEach(async () => {
    delete process.env.YGGDRASIL_PROVIDER_CONFIG_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  it("loadRegistry throws ProviderConfigError on corrupt JSON naming the path", async () => {
    const { setProviderConfigPathsForTest, loadRegistry, ProviderConfigError } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    await writeFile(join(dataDir, "providers.json"), "{ not json", "utf8");
    await expect(loadRegistry()).rejects.toThrow(ProviderConfigError);
    await expect(loadRegistry()).rejects.toThrow(/providers\.json/);
  });

  it("resolveApiKey prefers process.env over secrets map", async () => {
    const { resolveApiKeySync } = await import("@/lib/ai/provider-config/store");
    process.env.PROVIDER_T_API_KEY = "from-env";
    const m = new Map([["PROVIDER_T_API_KEY", "from-file"]]);
    expect(resolveApiKeySync({ apiKeyEnv: "PROVIDER_T_API_KEY" }, m)).toBe("from-env");
    delete process.env.PROVIDER_T_API_KEY;
    expect(resolveApiKeySync({ apiKeyEnv: "PROVIDER_T_API_KEY" }, m)).toBe("from-file");
  });

  it("saveRegistry keeps exactly one default when the doc contains two (demotion)", async () => {
    const { setProviderConfigPathsForTest, saveRegistry, loadRegistry } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    const model = (modelId: string, isDefault: boolean) => ({
      modelId, displayName: modelId, isDefault,
      capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text"], outputModalities: ["text"], supportsToolCalls: null, supportsReasoning: null },
      capabilitySources: {},
    });
    const doc = {
      version: 1 as const,
      providers: [
        { id: "p1", kind: "openai-compatible" as const, name: "P1", baseUrl: "http://localhost:1/v1", apiKeyEnv: "PROVIDER_P1_API_KEY", models: [model("m1", true)] },
        { id: "p2", kind: "openai-compatible" as const, name: "P2", baseUrl: "http://localhost:2/v1", models: [model("m2", false)] },
      ],
    } satisfies RegistryDocument;
    // Save valid doc with one default first.
    await saveRegistry(doc);
    const loaded1 = await loadRegistry();
    expect(loaded1.providers[0].models[0].isDefault).toBe(true);

    // Now save a second doc where the old default is still flagged AND a new default is set.
    const doc2 = structuredClone(doc) as RegistryDocument;
    doc2.providers[1].models[0].isDefault = true;
    await saveRegistry(doc2);
    const loaded2 = await loadRegistry();
    const defaults = loaded2.providers.flatMap((p) => p.models.filter((m) => m.isDefault));
    expect(defaults).toHaveLength(1);
    expect(defaults[0].modelId).toBe("m2");
  });

  it("loadRegistry throws ProviderConfigError with not-initialized message on ENOENT", async () => {
    const { setProviderConfigPathsForTest, loadRegistry, ProviderConfigError } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    await expect(loadRegistry()).rejects.toThrow(ProviderConfigError);
    await expect(loadRegistry()).rejects.toThrow(/not initialized/i);
  });
});
