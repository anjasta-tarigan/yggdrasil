import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real settings-service module pulls in the real SQLite db at import
// time, so it is always mocked here; the fake in-memory settings map is
// injected through ensureMigrated's deps (which default to the real
// settings-service in production).
vi.mock("@/lib/settings-service", () => ({
  getSettingsDb: vi.fn(),
  setSettingsDb: vi.fn(),
}));

let dataDir: string;
let savedEnv: NodeJS.ProcessEnv;
let fakeSettings: Record<string, unknown>;
let setSettingsCalls: Array<Record<string, unknown>>;

// Keep the module namespace (not destructured copies) so REGISTRY_PATH /
// SECRETS_PATH stay live bindings after setProviderConfigPathsForTest.
const storeMod = await import("@/lib/ai/provider-config/store");

const { ensureMigrated } = await import("@/lib/ai/provider-config/migrate");
const { getSettingsDb, setSettingsDb } = await import(
  "@/lib/settings-service"
);
const mockedGetSettingsDb = vi.mocked(getSettingsDb);
const mockedSetSettingsDb = vi.mocked(setSettingsDb);

// Build an independent (non-mocked) fake settings db for deps-injection.
// Each call gets a fresh fake so the injection branch (deps parameter)
// is exercised without vi.mock at all.
function makeInjectedDeps(settings: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    deps: {
      getSettingsDb: () => settings,
      setSettingsDb: (patch: Record<string, unknown>) => {
        calls.push(structuredClone(patch));
      },
    },
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ygg-migrate-"));
  storeMod.setProviderConfigPathsForTest(dataDir);
  savedEnv = { ...process.env };
  fakeSettings = {};
  setSettingsCalls = [];
  mockedGetSettingsDb.mockReset().mockImplementation(() => fakeSettings);
  mockedSetSettingsDb
    .mockReset()
    .mockImplementation((patch: Record<string, unknown>) => {
      setSettingsCalls.push(structuredClone(patch));
    });
});

afterEach(async () => {
  // Restore env vars exactly as they were — never mutate shared state.
  const keys = new Set([...Object.keys(process.env), ...Object.keys(savedEnv)]);
  for (const key of keys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ensureMigrated", () => {
  it("creates providers.json with server entry seeded from LLM_* when no file exists", async () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL_ID = "gpt-4o-mini";
    process.env.LLM_API_KEY = "sk-server-secret";
    fakeSettings = {};

    const report = await ensureMigrated();

    const doc = JSON.parse(await readFile(storeMod.REGISTRY_PATH, "utf8"));
    expect(doc.version).toBe(1);
    expect(doc.providers).toHaveLength(1);
    expect(doc.providers[0]).toMatchObject({
      id: "server",
      kind: "openai-compatible",
      name: "This server",
      baseUrl: "https://api.example.com/v1",
      apiKeyEnv: "PROVIDER_SERVER_API_KEY",
      source: "env",
    });
    expect(doc.providers[0].models).toHaveLength(1);
    expect(doc.providers[0].models[0]).toMatchObject({
      modelId: "gpt-4o-mini",
      displayName: "gpt-4o-mini",
      isDefault: true,
    });
    // Seeded model capabilities are pinned to the null-ish shape with
    // text-only modalities and no capability sources (models.dev
    // enrichment fills them in later).
    expect(doc.providers[0].models[0].capabilities).toEqual({
      contextWindow: null,
      maxOutputTokens: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalls: null,
      supportsReasoning: null,
    });
    expect(doc.providers[0].models[0].capabilitySources).toEqual({});
    // No plaintext key material ever lands in the registry JSON.
    expect(JSON.stringify(doc)).not.toContain("sk-server-secret");

    const secrets = await readFile(storeMod.SECRETS_PATH, "utf8");
    expect(secrets).toContain("PROVIDER_SERVER_API_KEY=sk-server-secret");

    expect(report).toEqual({
      seededServer: true,
      importedProviders: 0,
      importedEmbedding: false,
      createdEmpty: false,
    });
  });

  it("imports SQLite providers into providers.json and secrets file, then deletes old SQLite keys", async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    fakeSettings = {
      providers: [
        {
          id: "custom-1",
          kind: "openai-compatible",
          name: "Custom",
          baseUrl: "http://x/v1",
          apiKey: "sk-old",
        },
      ],
      embedding: {},
    };

    const report = await ensureMigrated();

    const doc = JSON.parse(await readFile(storeMod.REGISTRY_PATH, "utf8"));
    expect(doc.providers).toHaveLength(1);
    expect(doc.providers[0]).toMatchObject({
      id: "custom-1",
      kind: "openai-compatible",
      name: "Custom",
      baseUrl: "http://x/v1",
      apiKeyEnv: "PROVIDER_CUSTOM_1_API_KEY",
    });
    expect(doc.providers[0].models).toEqual([]);

    const secrets = await readFile(storeMod.SECRETS_PATH, "utf8");
    expect(secrets).toContain("PROVIDER_CUSTOM_1_API_KEY=sk-old");
    expect(JSON.stringify(doc)).not.toContain("sk-old");

    // Old SQLite keys are deleted only after the file write succeeded.
    expect(setSettingsCalls).toEqual([
      { providers: undefined, embedding: undefined },
    ]);
    expect(report).toEqual({
      seededServer: false,
      importedProviders: 1,
      importedEmbedding: false,
      createdEmpty: false,
    });
  });

  it("is idempotent — second call is a no-op when providers.json exists", async () => {
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    process.env.LLM_MODEL_ID = "gpt-4o-mini";
    process.env.LLM_API_KEY = "sk-server-secret";
    fakeSettings = {};

    await ensureMigrated();

    const before = await readFile(storeMod.REGISTRY_PATH, "utf8");
    const mtimeBefore = (await stat(storeMod.REGISTRY_PATH)).mtimeMs;
    const callsAfterFirst = setSettingsCalls.length;

    const report = await ensureMigrated();

    const after = await readFile(storeMod.REGISTRY_PATH, "utf8");
    expect(after).toBe(before);
    expect((await stat(storeMod.REGISTRY_PATH)).mtimeMs).toBe(mtimeBefore);

    // Second call never touches SQLite (no additional setSettingsDb call).
    expect(setSettingsCalls.length).toBe(callsAfterFirst);
    expect(report).toEqual({
      seededServer: false,
      importedProviders: 0,
      importedEmbedding: false,
      createdEmpty: false,
    });
  });

  it("creates empty providers:[] with onboarding hint when neither env nor SQLite has providers", async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    fakeSettings = {};

    const report = await ensureMigrated();

    const doc = JSON.parse(await readFile(storeMod.REGISTRY_PATH, "utf8"));
    expect(doc.version).toBe(1);
    expect(doc.providers).toEqual([]);
    // Onboarding-friendly: file written is valid, parseable, and empty —
    // the settings UI treats an empty list as "add your first provider".
    // (Format-agnostic: parse the JSON instead of matching raw text.)
    expect(doc.providers).toBeInstanceOf(Array);
    expect(report).toEqual({
      seededServer: false,
      importedProviders: 0,
      importedEmbedding: false,
      createdEmpty: true,
    });
  });

  it("keeps an embedding row carrying only tuning fields (dimensions/chunkSize) and reports importedEmbedding", async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    fakeSettings = {
      embedding: { dimensions: 768, chunkSize: 1000, chunkOverlap: 128 },
    };

    const report = await ensureMigrated();

    const doc = JSON.parse(await readFile(storeMod.REGISTRY_PATH, "utf8"));
    expect(doc.embedding).toEqual({
      providerId: null,
      dimensions: 768,
      chunkSize: 1000,
      chunkOverlap: 128,
    });
    expect(report.importedEmbedding).toBe(true);
    // Empty providers + kept embedding: createdEmpty stays true only when
    // nothing at all was imported (no providers AND no embedding).
    expect(report.createdEmpty).toBe(false);
  });

  it("degrades a dangling embedding providerId to null instead of failing the whole migration", async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    // provider: "server" with no matching server entry in the final doc.
    fakeSettings = {
      embedding: { provider: "server", model: "text-embed-3" },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const report = await ensureMigrated();

    const doc = JSON.parse(await readFile(storeMod.REGISTRY_PATH, "utf8"));
    expect(doc.embedding).toEqual({ providerId: null, model: "text-embed-3" });
    expect(warnSpy).toHaveBeenCalledWith(
      "[provider-config] migration: dropped dangling embedding providerId",
    );
    expect(report.importedEmbedding).toBe(true);
  });

  it("omits apiKeyEnv on env-name collision instead of pointing a second provider at the first's key", async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    // "custom-1" and "custom_1" both derive PROVIDER_CUSTOM_1_API_KEY.
    fakeSettings = {
      providers: [
        {
          id: "custom-1",
          kind: "openai-compatible",
          name: "Custom One",
          baseUrl: "http://x/v1",
          apiKey: "sk-first",
        },
        {
          id: "custom_1",
          kind: "openai-compatible",
          name: "Custom One Dup",
          baseUrl: "http://y/v1",
          apiKey: "sk-second",
        },
      ],
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ensureMigrated();

    const doc = JSON.parse(await readFile(storeMod.REGISTRY_PATH, "utf8"));
    expect(doc.providers).toHaveLength(2);
    // First provider keeps the derived env name + its key.
    expect(doc.providers[0].apiKeyEnv).toBe("PROVIDER_CUSTOM_1_API_KEY");
    expect(doc.providers[1].apiKeyEnv).toBeUndefined();
    const secrets = await readFile(storeMod.SECRETS_PATH, "utf8");
    expect(secrets).toContain("PROVIDER_CUSTOM_1_API_KEY=sk-first");
    expect(secrets).not.toContain("sk-second");
    expect(warnSpy).toHaveBeenCalledWith(
      "[provider-config] migration: apiKeyEnv collision skipped for 1 provider(s)",
    );
  });

  it("writes secrets before the registry — a secrets-write failure leaves no half-state and deletes nothing", async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    fakeSettings = {
      providers: [
        {
          id: "custom-1",
          kind: "openai-compatible",
          name: "Custom",
          baseUrl: "http://x/v1",
          apiKey: "sk-old",
        },
      ],
    };
    // Force the secrets write to fail. With the registry written first,
    // this failure would strand a half-state the idempotency guard can
    // never retry; with secrets first, nothing else runs.
    const secretsMod = await import("@/lib/ai/provider-config/secrets");
    vi.spyOn(secretsMod, "writeSecretsEnv").mockRejectedValue(
      new Error("simulated secrets write failure"),
    );

    await expect(ensureMigrated()).rejects.toThrow(
      "simulated secrets write failure",
    );

    // Registry must NOT have been written (retry on next boot is safe),
    // and the SQLite keys must NOT have been deleted.
    await expect(stat(storeMod.REGISTRY_PATH)).rejects.toThrow();
    expect(setSettingsCalls).toEqual([]);
  });

  it("accepts deps-injected settings fakes (no vi.mock) — the injection branch is covered", async () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
    const { calls, deps } = makeInjectedDeps({
      providers: [
        {
          id: "injected-1",
          kind: "ollama",
          name: "Injected",
          baseUrl: "http://localhost:11434/v1",
          apiKey: "sk-injected",
        },
      ],
    });

    const report = await ensureMigrated(deps);

    const doc = JSON.parse(await readFile(storeMod.REGISTRY_PATH, "utf8"));
    expect(doc.providers[0]).toMatchObject({
      id: "injected-1",
      apiKeyEnv: "PROVIDER_INJECTED_1_API_KEY",
    });
    const secrets = await readFile(storeMod.SECRETS_PATH, "utf8");
    expect(secrets).toContain("PROVIDER_INJECTED_1_API_KEY=sk-injected");
    expect(calls).toEqual([{ providers: undefined, embedding: undefined }]);
    expect(report.importedProviders).toBe(1);
  });
});
