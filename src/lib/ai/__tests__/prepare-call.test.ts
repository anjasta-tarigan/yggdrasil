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
  RegistryDocument,
} from "@/lib/ai/provider-config/schema";
import { ToolLoopAgent } from "ai";
import { buildSubagent } from "@/lib/ai/subagent-runner";
import { listSubagents } from "@/lib/ai/subagents-service";
import type { SubagentConfig } from "@/lib/ai/subagents-service";

let testDb: AppDatabase;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

/**
 * Access the ToolLoopAgent's private `settings` field for test inspection.
 * The agent stores prepareCall and callOptionsSchema there.
 */
function getAgentSettings(agent: ToolLoopAgent): Record<string, unknown> {
  return (agent as unknown as {
    settings: Record<string, unknown>;
  }).settings;
}

type PrepareCallResult = {
  options?: Record<string, unknown>;
  [key: string]: unknown;
};

type PrepareCallFn = (args: {
  options?: Record<string, unknown>;
  [key: string]: unknown;
}) => Promise<PrepareCallResult> | PrepareCallResult;

type SafeParseSchema = {
  safeParse: (input: unknown) => {
    success: boolean;
    data?: unknown;
    error?: unknown;
  };
};

/**
 * Extract the prepareCall callback from a built subagent's settings.
 * Returns undefined if prepareCall was not configured.
 */
function getPrepareCall(agent: ToolLoopAgent): PrepareCallFn | undefined {
  const settings = getAgentSettings(agent);
  return settings.prepareCall as PrepareCallFn | undefined;
}

/**
 * Extract the callOptionsSchema from a built subagent's settings.
 */
function getCallOptionsSchema(agent: ToolLoopAgent): SafeParseSchema | undefined {
  const settings = getAgentSettings(agent);
  return settings.callOptionsSchema as SafeParseSchema | undefined;
}

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

describe("prepareCall", () => {
  let dataDir: string;

  beforeEach(async () => {
    testDb = freshDb();
    vi.clearAllMocks();

    dataDir = await mkdtemp(join(tmpdir(), "ygg-prepare-call-"));
    setProviderConfigPathsForTest(dataDir);
    await saveRegistry(seedDoc());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("receives and returns the prompt unchanged", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const prepareCall = getPrepareCall(agent);
    expect(prepareCall).toBeTypeOf("function");

    const result = await prepareCall!({
      prompt: "Research the latest AI frameworks",
      instructions: config.instructions,
      options: {},
    });

    expect(result.prompt).toBe("Research the latest AI frameworks");
  });

  it("receives and returns instructions unchanged", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const prepareCall = getPrepareCall(agent);
    const result = await prepareCall!({
      prompt: "A task",
      instructions: config.instructions,
      options: {},
    });

    expect(result.instructions).toBe(config.instructions);
  });

  it("injects _taskDomain equal to the subagent config name into options", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const prepareCall = getPrepareCall(agent);
    const result = await prepareCall!({
      prompt: "Research quantum computing",
      instructions: config.instructions,
      options: {},
    });

    expect(result.options).toBeDefined();
    expect(result.options!._taskDomain).toBe(config.name);
    expect(result.options!._taskDomain).toBe("Researcher");
  });

  it("preserves existing call options when injecting _taskDomain", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const prepareCall = getPrepareCall(agent);
    const result = await prepareCall!({
      prompt: "Do something",
      instructions: config.instructions,
      options: { effort: "high", customFlag: 42 },
    });

    expect(result.options!._taskDomain).toBe(config.name);
    expect(result.options!._taskDomain).toBe("Researcher");
    expect(result.options!.effort).toBe("high");
    expect(result.options!.customFlag).toBe(42);
  });

  it("preserves other settings fields (model, tools, stopWhen) in the return", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);
    const settings = getAgentSettings(agent);

    const prepareCall = getPrepareCall(agent);
    const result = await prepareCall!({
      model: settings.model,
      tools: settings.tools,
      stopWhen: settings.stopWhen,
      instructions: config.instructions,
      prompt: "A task",
      options: {},
    });

    expect(result.model).toEqual(settings.model);
    expect(result.tools).toEqual(settings.tools);
    expect(result.stopWhen).toEqual(settings.stopWhen);
  });

  it("creates a prepareCall for the Coder subagent with its own _taskDomain", async () => {
    const seeded = listSubagents(testDb);
    const coder = seeded.find((s) => s.name === "Coder")!;
    const agent = await buildSubagent(coder);

    const prepareCall = getPrepareCall(agent);
    const result = await prepareCall!({
      prompt: "Write a test suite",
      instructions: coder.instructions,
      options: {},
    });

    expect(result.options!._taskDomain).toBe("Coder");
  });
});

describe("callOptionsSchema", () => {
  let dataDir: string;

  beforeEach(async () => {
    testDb = freshDb();
    vi.clearAllMocks();

    dataDir = await mkdtemp(join(tmpdir(), "ygg-prepare-call-"));
    setProviderConfigPathsForTest(dataDir);
    await saveRegistry(seedDoc());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("is present on the built subagent", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const schema = getCallOptionsSchema(agent);
    expect(schema).toBeDefined();
  });

  it("accepts valid call options with _taskDomain and effort", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const schema = getCallOptionsSchema(agent)!;
    const result = schema.safeParse({
      _taskDomain: "Researcher",
      effort: "high",
    });

    expect(result.success).toBe(true);
  });

  it("accepts an empty options object", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const schema = getCallOptionsSchema(agent)!;
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts all valid effort enum values", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const schema = getCallOptionsSchema(agent)!;
    for (const effort of ["low", "medium", "high", "auto"]) {
      const result = schema.safeParse({ effort });
      expect(result.success).toBe(true);
    }
  });

  it("rejects _taskDomain that is not a string", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const schema = getCallOptionsSchema(agent)!;
    const result = schema.safeParse({ _taskDomain: 123 });
    expect(result.success).toBe(false);
  });

  it("rejects effort that is not a valid enum value", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    const schema = getCallOptionsSchema(agent)!;
    const result = schema.safeParse({ effort: "urgent" });
    expect(result.success).toBe(false);
  });
});
