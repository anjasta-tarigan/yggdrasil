import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, PUT } from "../providers/route";
import {
  REGISTRY_PATH,
  saveRegistry,
  setProviderConfigPathsForTest,
} from "@/lib/ai/provider-config/store";
import { readSecretsMap } from "@/lib/ai/provider-config/secrets";
import type {
  ModelEntry,
  RegistryDocument,
} from "@/lib/ai/provider-config/schema";

// GET runs ensureMigrated, which imports the real settings-service (and
// through it the real SQLite database) at module load. The tests only
// need "no legacy settings to import", so serve an empty store.
vi.mock("@/lib/settings-service", () => ({
  getSettingsDb: vi.fn(() => ({})),
  setSettingsDb: vi.fn(),
}));

const model = (modelId: string, isDefault = false): ModelEntry => ({
  modelId,
  displayName: modelId,
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

function baseDoc(): RegistryDocument {
  return structuredClone({
    version: 1,
    providers: [
      {
        id: "p1",
        kind: "openai-compatible",
        name: "P1",
        baseUrl: "http://localhost:9001/v1",
        apiKeyEnv: "PROVIDER_P1_API_KEY",
        models: [model("m1", true)],
      },
      {
        id: "p2",
        kind: "openai-compatible",
        name: "P2",
        baseUrl: "http://localhost:9002/v1",
        models: [model("m2")],
      },
    ],
  } satisfies RegistryDocument);
}

function putRequest(doc: unknown): Request {
  return new Request("http://localhost/api/providers", {
    method: "PUT",
    body: JSON.stringify(doc),
  });
}

describe("providers API routes", () => {
  let dataDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    savedEnv = { ...process.env };
  });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ygg-providers-api-"));
    process.env.YGGDRASIL_PROVIDER_CONFIG_DIR = dataDir;
    setProviderConfigPathsForTest(dataDir);
    // Migration must be deterministic regardless of the host shell.
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL_ID;
    delete process.env.LLM_API_KEY;
  });

  afterEach(async () => {
    const keys = new Set([...Object.keys(process.env), ...Object.keys(savedEnv)]);
    for (const key of keys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  it("GET returns a redacted view: apiKeyConfigured flags, never key values", async () => {
    await saveRegistry(baseDoc());
    const { writeSecretsEnv } = await import(
      "@/lib/ai/provider-config/secrets"
    );
    await writeSecretsEnv(new Map([["PROVIDER_P1_API_KEY", "sk-live-secret-123"]]));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toHaveLength(2);
    for (const p of body.providers) {
      expect(p).not.toHaveProperty("apiKey");
      expect(p).toHaveProperty("apiKeyConfigured");
    }
    expect(body.providers[0].apiKeyConfigured).toBe(true);
    expect(body.providers[1].apiKeyConfigured).toBe(false);
    expect(JSON.stringify(body)).not.toContain("sk-live-secret-123");
  });

  it("GET migrates an absent registry on first load and returns an empty view", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers).toEqual([]);
    // ensureMigrated created the registry file.
    await expect(stat(REGISTRY_PATH)).resolves.toBeTruthy();
  });

  it("PUT with a non-empty apiKey stores it in the secrets file, never in providers.json", async () => {
    await saveRegistry(baseDoc());
    const doc = baseDoc() as unknown as Record<string, unknown>;
    const providers = doc.providers as Array<Record<string, unknown>>;
    providers[0].apiKey = "sk-rotated-456";
    // Round-trip noise from the redacted GET view must be stripped.
    providers[0].apiKeyConfigured = true;
    providers[0].extraField = "strip-me";

    const res = await PUT(putRequest(doc));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providers[0].apiKeyConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-rotated-456");

    // Secret lives in the secrets file under the derived env name.
    const secrets = await readSecretsMap();
    expect(secrets.get("PROVIDER_P1_API_KEY")).toBe("sk-rotated-456");

    // The stored document holds apiKeyEnv only — never the value.
    const stored = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(stored.providers[0]).not.toHaveProperty("apiKey");
    expect(stored.providers[0]).not.toHaveProperty("apiKeyConfigured");
    expect(stored.providers[0]).not.toHaveProperty("extraField");
    expect(stored.providers[0].apiKeyEnv).toBe("PROVIDER_P1_API_KEY");
  });

  it("PUT with an empty apiKey leaves the stored secret untouched", async () => {
    await saveRegistry(baseDoc());
    const { writeSecretsEnv } = await import(
      "@/lib/ai/provider-config/secrets"
    );
    await writeSecretsEnv(new Map([["PROVIDER_P1_API_KEY", "sk-original"]]));

    const doc = baseDoc() as unknown as Record<string, unknown>;
    (doc.providers as Array<Record<string, unknown>>)[0].apiKey = "";

    const res = await PUT(putRequest(doc));
    expect(res.status).toBe(200);
    const secrets = await readSecretsMap();
    expect(secrets.get("PROVIDER_P1_API_KEY")).toBe("sk-original");
    const body = await res.json();
    expect(body.providers[0].apiKeyConfigured).toBe(true);
  });

  it("PUT with clearApiKey removes the stored secret", async () => {
    await saveRegistry(baseDoc());
    const { writeSecretsEnv } = await import(
      "@/lib/ai/provider-config/secrets"
    );
    await writeSecretsEnv(new Map([["PROVIDER_P1_API_KEY", "sk-doomed"]]));

    const doc = baseDoc() as unknown as Record<string, unknown>;
    (doc.providers as Array<Record<string, unknown>>)[0].clearApiKey = true;

    const res = await PUT(putRequest(doc));
    expect(res.status).toBe(200);
    const secrets = await readSecretsMap();
    expect(secrets.has("PROVIDER_P1_API_KEY")).toBe(false);
    const body = await res.json();
    expect(body.providers[0].apiKeyConfigured).toBe(false);
  });

  it("PUT demotes the previous default when two models claim isDefault", async () => {
    await saveRegistry(baseDoc());
    const doc = baseDoc();
    doc.providers[1].models[0].isDefault = true; // second default → wins

    const res = await PUT(putRequest(doc));
    expect(res.status).toBe(200);
    const body = await res.json();
    const defaults = body.providers.flatMap(
      (p: { models: Array<{ modelId: string; isDefault: boolean }> }) =>
        p.models.filter((m) => m.isDefault),
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].modelId).toBe("m2");
  });

  it("PUT rejects invalid documents and malformed JSON with 400, persisting nothing", async () => {
    await saveRegistry(baseDoc());
    const before = await readFile(REGISTRY_PATH, "utf8");

    const badBaseUrl = baseDoc() as unknown as Record<string, unknown>;
    ((badBaseUrl.providers as Array<Record<string, unknown>>)[0] as Record<string, unknown>).baseUrl = "file:///etc/passwd";
    const unknownKind = baseDoc() as unknown as Record<string, unknown>;
    ((unknownKind.providers as Array<Record<string, unknown>>)[0] as Record<string, unknown>).kind = "anthropic";
    const duplicateIds = baseDoc() as unknown as Record<string, unknown>;
    (duplicateIds.providers as Array<Record<string, unknown>>)[1].id = "p1";
    const unknownTopLevelKey = { ...baseDoc(), oops: true };
    const wrongVersion = { ...baseDoc(), version: 2 };

    const cases: Array<unknown> = [
      badBaseUrl,
      unknownKind,
      duplicateIds,
      unknownTopLevelKey,
      wrongVersion,
      {},
    ];
    for (const payload of cases) {
      const res = await PUT(putRequest(payload));
      expect(res.status).toBe(400);
    }
    const malformed = await PUT(
      new Request("http://localhost/api/providers", {
        method: "PUT",
        body: "{not json",
      })
    );
    expect(malformed.status).toBe(400);

    expect(await readFile(REGISTRY_PATH, "utf8")).toBe(before);
  });

  it("GET reports 500 when the registry file is corrupt", async () => {
    await writeFile(REGISTRY_PATH, "{ not json", "utf8");
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/corrupt/);
  });
});
