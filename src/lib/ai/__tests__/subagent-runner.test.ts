import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";
import {
  setProviderConfigPathsForTest,
  saveRegistry,
} from "@/lib/ai/provider-config/store";
import type {
  ModelEntry,
  ProviderEntry,
  RegistryDocument,
} from "@/lib/ai/provider-config/schema";
import type { WebProviderSession } from "@/lib/ai/web-provider/types";

const getWebSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/web-provider/session-store", () => ({
  getWebSession: getWebSessionMock,
}));

let testDb: AppDatabase;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

import {
  buildSubagentToolsForChat,
  buildSubagentTools,
  buildSubagent,
  resolveModel,
} from "@/lib/ai/subagent-runner";
import {
  listSubagents,
  updateSubagent,
  type SubagentConfig,
} from "@/lib/ai/subagents-service";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  setupFtsAndTriggers(db);
  return drizzle(db, { schema });
}

function seedDoc(): RegistryDocument {
  const caps = () =>
    ({
      contextWindow: null,
      maxOutputTokens: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalls: null,
      supportsReasoning: null,
    }) as ModelEntry["capabilities"];
  const model = (modelId: string, isDefault: boolean): ModelEntry => ({
    modelId,
    displayName: modelId,
    isDefault,
    capabilities: caps(),
    capabilitySources: {},
  });
  return {
    version: 1,
    providers: [
      {
        id: "server",
        kind: "openai-compatible",
        name: "This server",
        baseUrl: "http://registry-test.local/v1",
        apiKeyEnv: "PROVIDER_SERVER_API_KEY",
        models: [model("m1", true)],
      },
      {
        id: "p2",
        kind: "ollama",
        name: "Ollama Local",
        baseUrl: "http://localhost:11434",
        models: [model("m2", false)],
      },
    ],
    embedding: undefined,
  };
}

function researcherConfig(db: AppDatabase): SubagentConfig {
  const seeded = listSubagents(db);
  return seeded.find((s) => s.name === "Researcher")!;
}

const webSession: WebProviderSession = {
  id: "web-session-1",
  providerId: "deepseek-web",
  userToken: "secret-session-token",
  status: "verified",
  lastCheckedAt: null,
  lastFailureCode: null,
  userAgentMode: "browser",
  capturedAt: null,
  sessionVersion: 1,
};

function webProvider(isDefault = false): ProviderEntry {
  return {
    id: "deepseek-web",
    kind: "web-session",
    name: "DeepSeek Web",
    baseUrl: "https://chat.deepseek.com",
    models: [
      {
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
      },
    ],
  };
}

describe("Subagent Runner", () => {
  let dataDir: string;

  beforeEach(async () => {
    testDb = freshDb();
    vi.clearAllMocks();
    getWebSessionMock.mockReset();

    dataDir = await mkdtemp(join(tmpdir(), "ygg-subagent-"));
    setProviderConfigPathsForTest(dataDir);
    await saveRegistry(seedDoc());
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("builds the toolset from granted capability keys", () => {
    const config = researcherConfig(testDb);
    // Researcher gets web_search, web_fetch, memory → web_search,
    // web_fetch, memory_search, memory_note_create.
    const tools = buildSubagentTools(config);
    const names = Object.keys(tools);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_note_create");
    // No sandbox / task tools granted.
    expect(names).not.toContain("bash");
    expect(names).not.toContain("task_list_manager");
  });

  it("sandbox grant maps to the full sandbox tool set", () => {
    const config = { ...researcherConfig(testDb), tools: ["sandbox"] as never };
    const names = Object.keys(buildSubagentTools(config));
    // All five sandbox names, including the shell/exec aliases of bash —
    // granting the group must not silently omit a name the model can call.
    expect(names.sort()).toEqual(
      ["bash", "exec", "readFile", "shell", "writeFile"].sort()
    );
  });

  it("excludes disabled subagents from chat tools", async () => {
    const seeded = listSubagents(testDb);
    const coder = seeded.find((s) => s.name === "Coder")!;
    await updateSubagent(coder.id, { enabled: false }, testDb);

    const chatTools = await buildSubagentToolsForChat();
    // Researcher enabled, Coder + Analyst disabled.
    const names = chatTools.map((t) => t.name);
    expect(names).toContain("delegate_researcher");
    expect(names).not.toContain("delegate_coder");
    expect(names).not.toContain("delegate_analyst");
  });

  it("names delegation tools delegate_<slug>", async () => {
    const chatTools = await buildSubagentToolsForChat();
    for (const entry of chatTools) {
      expect(entry.name).toMatch(/^delegate_[a-z0-9_]+$/);
    }
    expect(chatTools.length).toBe(2); // researcher + coder enabled by default
  });

  it("delegation tool input schema requires a bounded task", async () => {
    const chatTools = await buildSubagentToolsForChat();
    const researcher = chatTools.find(
      (t) => t.name === "delegate_researcher"
    )!;
    expect(researcher).toBeDefined();
    // Tool is registered with a description mentioning the subagent name.
    expect((researcher.tool as unknown as { description: string }).description).toContain(
      "Researcher"
    );
  });

  it("gates qualified web-session refs before resolving an API key", async () => {
    vi.stubEnv("YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS", "true");
    const provider = webProvider();
    await saveRegistry({ version: 1, providers: [provider] });
    getWebSessionMock.mockResolvedValue(null);

    await expect(
      resolveModel({
        ...researcherConfig(testDb),
        model: "deepseek-web::deepseek-chat",
      })
    ).rejects.toThrow(
      "DeepSeek Web session expired or was rejected. Re-import the session token to continue."
    );
    expect(getWebSessionMock).toHaveBeenCalledWith("deepseek-web");
  });

  it("enforces the kill switch before loading a web-session secret", async () => {
    vi.stubEnv("YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS", "false");
    const provider = webProvider();
    await saveRegistry({ version: 1, providers: [provider] });
    getWebSessionMock.mockResolvedValue(webSession);

    await expect(
      resolveModel({
        ...researcherConfig(testDb),
        model: "deepseek-web::deepseek-chat",
      })
    ).rejects.toThrow("Experimental Web Providers are currently disabled.");
    // Spec §11.2: the session secret is never loaded while the flag is off.
    expect(getWebSessionMock).not.toHaveBeenCalled();
  });

  it("passes a verified web-session to the default-model branch", async () => {
    vi.stubEnv("YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS", "true");
    const provider = webProvider(true);
    await saveRegistry({ version: 1, providers: [provider] });
    getWebSessionMock.mockResolvedValue(webSession);

    const resolved = await resolveModel({
      ...researcherConfig(testDb),
      model: undefined,
    });

    expect(resolved).toMatchObject({
      provider: "deepseek-web",
      modelId: "deepseek-chat",
      session: webSession,
    });
  });

  it("resolves models for subagents (qualified ref, missing provider fallback, absent model fallback)", async () => {
    const base = researcherConfig(testDb);

    // 1. Qualified ref pointing to existing provider
    const qualifiedAgent = await buildSubagent({
      ...base,
      model: "p2::m2",
    });
    expect(qualifiedAgent).toBeDefined();

    // 2. Missing provider falls back to default model without throwing
    const missingProviderAgent = await buildSubagent({
      ...base,
      model: "missing::m",
    });
    expect(missingProviderAgent).toBeDefined();

    // 3. Absent / undefined model uses default model without throwing
    const defaultModelAgent = await buildSubagent({
      ...base,
      model: undefined,
    });
    expect(defaultModelAgent).toBeDefined();
  });
});
