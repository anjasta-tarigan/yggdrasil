import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { applyRegistryPatch } from "../api-helpers";
import * as store from "../store";
import * as secrets from "../secrets";
import { ProviderEntrySchema, type ProviderEntry } from "../schema";

const nim = (extra: Record<string, unknown> = {}) => ({
  id: "nim", kind: "openai-compatible", preset: "nvidia-nim", name: "NIM",
  baseUrl: "https://integrate.api.nvidia.com/v1", models: [],
  apiKeys: [{ id: "first", value: " secret-one " }, { id: "second", value: "secret-two" }],
  ...extra,
});
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(process.cwd(), "tmp/nim-persistence-"));
  store.setProviderConfigPathsForTest(directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function savedNim(): Promise<ProviderEntry> {
  expect(await applyRegistryPatch({ providers: [nim()] })).toEqual({ ok: true });
  return (await store.loadRegistry()).providers[0];
}

describe("NIM pool persistence", () => {
  it("stores only refs, redacts GET rows, resolves in order without rotation", async () => {
    const entry = await savedNim();
    expect(entry).toHaveProperty("preset", "nvidia-nim");
    expect(entry.apiKeys).toHaveLength(2);
    const text = await readFile(join(directory, "providers.json"), "utf8");
    expect(text).not.toContain("secret-one");
    const view = (await store.getRegistryView()).providers[0];
    expect(view.apiKeys).toEqual(entry.apiKeys!.map(row => ({ ...row, configured: true })));
    expect(view.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain("secret-");
    expect(await store.resolveApiKeys(entry)).toEqual(["secret-one", "secret-two"]);
    expect(await store.resolveApiKeys(entry)).toEqual(["secret-one", "secret-two"]);
    vi.stubEnv(entry.apiKeys![0].apiKeyEnv, "override");
    expect(await store.resolveApiKeys(entry)).toEqual(["override", "secret-two"]);
  });

  it("preserves saved IDs on echo and ID-only updates, removes dropped rows", async () => {
    const entry = await savedNim();
    const view = (await store.getRegistryView()).providers[0];
    expect(await applyRegistryPatch({ providers: [view] })).toEqual({ ok: true });
    expect(await applyRegistryPatch({ providers: [nim({ apiKeys: [{ id: "second" }] })] })).toEqual({ ok: true });
    const updated = (await store.loadRegistry()).providers[0];
    expect(updated.apiKeys).toEqual([entry.apiKeys![1]]);
    expect(await store.resolveApiKeys(updated)).toEqual(["secret-two"]);
    expect((await secrets.readSecretsMap()).has(entry.apiKeys![0].apiKeyEnv)).toBe(false);
  });

  it("removes deleted provider secrets but preserves references held by legacy providers and embedding", async () => {
    const entry = await savedNim();
    const refs = entry.apiKeys!;
    const legacy = { id: "legacy", kind: "openai-compatible", name: "Legacy", baseUrl: "https://example.com/v1", apiKeyEnv: refs[0].apiKeyEnv };
    expect(await applyRegistryPatch({ providers: [entry, legacy], embedding: { providerId: null, apiKeyEnv: refs[1].apiKeyEnv } })).toEqual({ ok: true });
    expect(await applyRegistryPatch({ providers: [legacy] })).toEqual({ ok: true });
    expect((await secrets.readSecretsMap()).size).toBe(2);
    expect(await applyRegistryPatch({ providers: [], embedding: { providerId: null } })).toEqual({ ok: true });
    expect((await secrets.readSecretsMap()).size).toBe(0);
  });

  it.each([
    { apiKeys: [] }, { apiKeys: undefined }, { apiKeyEnv: "PROVIDER_NIM_API_KEY" },
    { apiKey: "legacy" }, { clearApiKey: true }, { kind: "ollama" },
    { baseUrl: "https://example.com/v1" },
    { apiKeys: [{ id: "same", value: "one" }, { id: "same", value: "two" }] },
    { apiKeys: [{ id: "", value: "one" }] }, { apiKeys: [{ id: "../bad", value: "one" }] },
    { apiKeys: [{ id: "x" }] }, { apiKeys: [{ id: "x", value: " " }] },
    { apiKeys: [{ id: "x", value: "secret\n" }] }, { apiKeys: [{ id: "x", value: "secret\r" }] },
    { apiKeys: [{ id: "x", value: "x".repeat(8193) }] },
    { apiKeys: Array.from({ length: 21 }, (_, i) => ({ id: `k${i}`, value: "key" })) },
    { apiKeys: [{ id: "x", apiKeyEnv: "PROVIDER_OTHER_API_KEY" }] },
  ])("rejects invalid input without mutation (case %#)", async (extra) => {
    expect(await applyRegistryPatch({ providers: [nim(extra)] })).toMatchObject({ ok: false, status: 400 });
    expect(await secrets.readSecretsMap()).toEqual(new Map());
    await expect(readFile(join(directory, "providers.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects forged references even for existing IDs", async () => {
    const entry = await savedNim();
    const result = await applyRegistryPatch({ providers: [nim({ apiKeys: [{ id: "first", apiKeyEnv: entry.apiKeys![1].apiKeyEnv }] })] });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await store.resolveApiKeys(entry)).toEqual(["secret-one", "secret-two"]);
  });

  it("does not accept another provider's saved ID without a new value", async () => {
    const entry = await savedNim();
    expect(await applyRegistryPatch({ providers: [entry, nim({ id: "other", apiKeys: [entry.apiKeys![0]] })] })).toMatchObject({ ok: false, status: 400 });
  });

  it("derives distinct stable refs for case and punctuation variants", async () => {
    const providers = ["a-b", "a_b", "A-b"].map(id => nim({ id, apiKeys: [{ id: "a-b", value: "one" }, { id: "a_b", value: "two" }, { id: "A-b", value: "three" }] }));
    expect(await applyRegistryPatch({ providers })).toEqual({ ok: true });
    const doc = await store.loadRegistry();
    const refs = doc.providers.flatMap(p => p.apiKeys!.map(k => k.apiKeyEnv));
    expect(new Set(refs).size).toBe(9);
    expect(await applyRegistryPatch({ providers })).toEqual({ ok: true });
    expect(await store.loadRegistry()).toEqual(doc);
  });

  it("fails clearly on a missing pool ref without leaking another value", async () => {
    const entry = await savedNim();
    const map = await secrets.readSecretsMap();
    map.delete(entry.apiKeys![1].apiKeyEnv);
    await secrets.writeSecretsEnv(map);
    await expect(store.resolveApiKeys(entry)).rejects.toThrow(/not configured/i);
    await expect(store.resolveApiKeys(entry)).rejects.not.toThrow(/secret-one/);
    expect((await store.getRegistryView()).providers[0].apiKeys![1].configured).toBe(false);
  });

  it("resolves the first configured pool key for legacy single-key callers", async () => {
    const entry = await savedNim();
    expect(await store.resolveApiKey(entry)).toBe("secret-one");
    const map = await secrets.readSecretsMap();
    map.delete(entry.apiKeys![0].apiKeyEnv);
    await secrets.writeSecretsEnv(map);
    expect(await store.resolveApiKey(entry)).toBe("secret-two");
    vi.stubEnv(entry.apiKeys![0].apiKeyEnv, "override");
    expect(await store.resolveApiKey(entry)).toBe("override");
    vi.stubEnv(entry.apiKeys![0].apiKeyEnv, "");
    await secrets.writeSecretsEnv(new Map());
    expect(await store.resolveApiKey(entry)).toBeUndefined();
  });

  it("keeps legacy resolution supported", async () => {
    await secrets.writeSecretsEnv(new Map([["PROVIDER_OLD_API_KEY", "old"]]));
    const entry = { apiKeyEnv: "PROVIDER_OLD_API_KEY" };
    expect(await store.resolveApiKeys(entry)).toEqual(["old"]);
    expect(await store.resolveApiKey(entry)).toBe("old");
    expect(await store.resolveApiKeys({})).toEqual([]);
  });

  it("validates persisted NIM configuration rather than silently stripping it", () => {
    const persisted = nim({ apiKeys: [{ id: "first", apiKeyEnv: "PROVIDER_NIM_FIRST_API_KEY" }] });
    expect(ProviderEntrySchema.safeParse(persisted).success).toBe(true);
    expect(ProviderEntrySchema.safeParse({ ...persisted, baseUrl: "https://example.com/v1" }).success).toBe(false);
    expect(ProviderEntrySchema.safeParse({ ...persisted, apiKeys: [] }).success).toBe(false);
    expect(ProviderEntrySchema.safeParse({ ...persisted, apiKeyEnv: "PROVIDER_OLD_API_KEY" }).success).toBe(false);
  });

  it("serializes concurrent patches so a queued ID-only patch sees the preceding write", async () => {
    const results = await Promise.all([
      applyRegistryPatch({ providers: [nim()] }),
      applyRegistryPatch({ providers: [nim({ apiKeys: [{ id: "second" }] })] }),
    ]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(await store.resolveApiKeys((await store.loadRegistry()).providers[0])).toEqual(["secret-two"]);
    expect((await secrets.readSecretsMap()).size).toBe(1);
  });

  it.each(['token=#\\"quoted', '"quoted"', "'quoted'"])("round-trips punctuation in key value %s", async (value) => {
    expect(await applyRegistryPatch({ providers: [nim({ apiKeys: [{ id: "first", value }] })] })).toEqual({ ok: true });
    expect(await store.resolveApiKeys((await store.loadRegistry()).providers[0])).toEqual([value]);
  });

  it("rolls back staged secrets if registry publication fails", async () => {
    const entry = await savedNim();
    vi.spyOn(store, "saveRegistry").mockRejectedValueOnce(new Error("disk failure"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await applyRegistryPatch({ providers: [nim({ apiKeys: [{ id: "first", value: "replacement" }] })] })).toMatchObject({ ok: false, status: 500 });
    expect(await store.loadRegistry()).toMatchObject({ providers: [entry] });
    expect(await store.resolveApiKeys(entry)).toEqual(["secret-one", "secret-two"]);
  });

  it("does not publish a new registry if preparing secrets fails", async () => {
    vi.spyOn(secrets, "writeSecretsEnv").mockRejectedValueOnce(new Error("disk failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await applyRegistryPatch({ providers: [nim()] })).toMatchObject({ ok: false, status: 500 });
    await expect(readFile(join(directory, "providers.json"))).rejects.toMatchObject({ code: "ENOENT" });
    log.mockRestore();
  });

  it("demotes a web-session model's isDefault instead of rejecting the patch", async () => {
    const webSession = {
      id: "deepseek-web", kind: "web-session", preset: "deepseek-web", name: "DeepSeek Web",
      baseUrl: "https://chat.deepseek.com",
      models: [{
        modelId: "deepseek-chat", displayName: "DeepSeek Chat", isDefault: true,
        capabilities: { contextWindow: null, maxOutputTokens: null, inputModalities: ["text"], outputModalities: ["text"], supportsToolCalls: null, supportsReasoning: null },
        capabilitySources: {},
      }],
    };
    expect(await applyRegistryPatch({ providers: [webSession] })).toEqual({ ok: true });
    const entry = (await store.loadRegistry()).providers[0];
    expect(entry.models[0].isDefault).toBe(false);
  });
});
