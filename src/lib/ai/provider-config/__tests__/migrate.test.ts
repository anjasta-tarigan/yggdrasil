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
    expect(await readFile(storeMod.REGISTRY_PATH, "utf8")).toContain('"providers": []');
    expect(report).toEqual({
      seededServer: false,
      importedProviders: 0,
      importedEmbedding: false,
      createdEmpty: true,
    });
  });
});
