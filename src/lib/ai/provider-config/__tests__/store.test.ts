import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text" as const], outputModalities: ["text" as const], supportsToolCalls: null, supportsReasoning: null },
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

  it("saveRegistry demotes a web-session model's isDefault to false and persists it", async () => {
    const { setProviderConfigPathsForTest, saveRegistry, loadRegistry } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    const doc = {
      version: 1 as const,
      providers: [
        {
          id: "deepseek-web",
          kind: "web-session" as const,
          preset: "deepseek-web" as const,
          name: "DeepSeek Web",
          baseUrl: "https://chat.deepseek.com",
          models: [
            {
              modelId: "deepseek-chat", displayName: "DeepSeek Chat", isDefault: true,
              capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text" as const], outputModalities: ["text" as const], supportsToolCalls: null, supportsReasoning: null },
              capabilitySources: {},
            },
          ],
        },
        { id: "p2", kind: "openai-compatible" as const, name: "P2", baseUrl: "http://localhost:2/v1", apiKeyEnv: "PROVIDER_P2_API_KEY", models: [] },
      ],
    } satisfies RegistryDocument;
    await saveRegistry(doc);
    const loaded = await loadRegistry();
    expect(loaded.providers[0].models[0].isDefault).toBe(false);
    expect(loaded.providers.flatMap((p) => p.models.filter((m) => m.isDefault))).toHaveLength(0);
  });

  it("loadRegistry throws ProviderConfigError with not-initialized message on ENOENT", async () => {
    const { setProviderConfigPathsForTest, loadRegistry, ProviderConfigError } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    await expect(loadRegistry()).rejects.toThrow(ProviderConfigError);
    await expect(loadRegistry()).rejects.toThrow(/not initialized/i);
  });

  it("loadRegistry throws ProviderConfigError naming the first Zod issue on schema-invalid JSON", async () => {
    const { setProviderConfigPathsForTest, loadRegistry, ProviderConfigError } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    // Syntactically valid JSON, but version must be the literal 1.
    await writeFile(join(dataDir, "providers.json"), JSON.stringify({ version: 2, providers: [] }), "utf8");
    await expect(loadRegistry()).rejects.toThrow(ProviderConfigError);
    await expect(loadRegistry()).rejects.toThrow(/providers\.json is invalid: version: Invalid input: expected 1/);
  });

  it("loadRegistry clears a legacy web-session default in memory without rewriting the file", async () => {
    // A registry written before the invariant existed may hold a web-session
    // default. Rejecting it at read time would brick every route (and there is
    // no UI path to repair it, since every read fails first), so the flag is
    // demoted in memory and the next successful write persists the clean form.
    const { setProviderConfigPathsForTest, loadRegistry } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    const legacy = {
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
              modelId: "deepseek-chat", displayName: "DeepSeek Chat", isDefault: true,
              capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text"], outputModalities: ["text"], supportsToolCalls: null, supportsReasoning: null },
              capabilitySources: {},
            },
          ],
        },
      ],
    };
    const file = join(dataDir, "providers.json");
    const text = JSON.stringify(legacy);
    await writeFile(file, text, "utf8");

    const loaded = await loadRegistry();
    expect(loaded.providers[0].models[0].isDefault).toBe(false);
    // Reads stay side-effect-free: the on-disk document is untouched.
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("loadRegistry still rejects a genuinely malformed document", async () => {
    const { setProviderConfigPathsForTest, loadRegistry, ProviderConfigError } = await import("@/lib/ai/provider-config/store");
    setProviderConfigPathsForTest(dataDir);
    // `providers` is not an array — no amount of demotion makes this valid.
    await writeFile(join(dataDir, "providers.json"), JSON.stringify({ version: 1, providers: "nope" }), "utf8");
    await expect(loadRegistry()).rejects.toThrow(ProviderConfigError);
    await expect(loadRegistry()).rejects.toThrow(/providers\.json is invalid/);
  });
});
