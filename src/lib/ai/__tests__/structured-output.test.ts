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
import { buildSubagent, buildSubagentTool } from "@/lib/ai/subagent-runner";
import {
  SubagentResultSchema,
  type SubagentResult,
} from "@/lib/ai/tools/subagent-result";
import type {
  ModelEntry,
  RegistryDocument,
} from "@/lib/ai/provider-config/schema";
import type { SubagentConfig } from "@/lib/ai/subagents-service";
import { listSubagents } from "@/lib/ai/subagents-service";

// ---------------------------------------------------------------------------
// Helpers shared between the DB-backed describe blocks.
// ---------------------------------------------------------------------------

let testDb: AppDatabase;

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

// A minimal config that does NOT require a live model — used for toModelOutput
// unit tests (buildSubagentTool never touches the model provider).
function minimalConfig(): SubagentConfig {
  return {
    id: "test-minimal",
    name: "TestBot",
    instructions: "You are a test subagent.",
    tools: [],
    enabled: true,
    maxSteps: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Extract toModelOutput from a built subagent tool for direct testing.
 * Returns undefined if toModelOutput was not configured.
 */
function getToModelOutput(
  config: SubagentConfig,
): ((opts: { output: unknown }) => { type: string; value: string }) | undefined {
  const built = buildSubagentTool(config);
  const tool = built.tool as unknown as {
    toModelOutput?: (opts: { output: unknown }) => { type: string; value: string };
  };
  return tool.toModelOutput;
}

// ---------------------------------------------------------------------------
// SubagentResultSchema — pure schema validation (no DB needed).
// ---------------------------------------------------------------------------

const validResult: SubagentResult = {
  summary: "Researched the latest AI SDK features.",
  keyFindings: ["Output.object was added in v7", "ToolLoopAgent supports structured output"],
  nextSteps: ["Update the runner to use Output.object", "Add migration tests"],
};

describe("SubagentResultSchema", () => {
  it("accepts a valid object with summary, keyFindings, and nextSteps", () => {
    const result = SubagentResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe(validResult.summary);
      expect(result.data.keyFindings).toEqual(validResult.keyFindings);
      expect(result.data.nextSteps).toEqual(validResult.nextSteps);
    }
  });

  it("rejects a missing summary", () => {
    const result = SubagentResultSchema.safeParse({
      keyFindings: ["f1"],
      nextSteps: ["s1"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string summary", () => {
    const result = SubagentResultSchema.safeParse({
      summary: "",
      keyFindings: ["f1"],
      nextSteps: ["s1"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects keyFindings that is not an array", () => {
    const result = SubagentResultSchema.safeParse({
      summary: "ok",
      keyFindings: "not-an-array",
      nextSteps: ["s1"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects nextSteps that is not an array", () => {
    const result = SubagentResultSchema.safeParse({
      summary: "ok",
      keyFindings: ["f1"],
      nextSteps: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string summary", () => {
    const result = SubagentResultSchema.safeParse({
      summary: 123,
      keyFindings: ["f1"],
      nextSteps: ["s1"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects array elements that are not strings", () => {
    const result = SubagentResultSchema.safeParse({
      summary: "ok",
      keyFindings: ["valid", 99],
      nextSteps: ["ok"],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSubagent() — the output field must be set to Output.object(...).
// ---------------------------------------------------------------------------

describe("buildSubagent() structured output", () => {
  let dataDir: string;

  beforeEach(async () => {
    testDb = freshDb();
    vi.clearAllMocks();

    dataDir = await mkdtemp(join(tmpdir(), "ygg-structured-"));
    setProviderConfigPathsForTest(dataDir);
    await saveRegistry(seedDoc());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("includes the output field set to Output.object with the SubagentResultSchema", async () => {
    const config = researcherConfig(testDb);
    const agent = await buildSubagent(config);

    // ToolLoopAgent stores settings (including `output`) privately; access
    // it the same way prepare-call.test.ts accesses prepareCall.
    const settings = (agent as unknown as { settings: Record<string, unknown> }).settings;
    const outputSpec = settings.output;

    expect(outputSpec).toBeDefined();
    expect(outputSpec).not.toBeNull();
    // Output.object(...) returns an object with name === 'object'.
    expect((outputSpec as { name: string }).name).toBe("object");
    // The spec must be callable to parse complete output (proves it's a real
    // Output.object result, not a bare object).
    expect(
      typeof (outputSpec as { parseCompleteOutput?: unknown }).parseCompleteOutput,
    ).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// buildSubagentTool() — toModelOutput structured vs. fallback behaviour.
// ---------------------------------------------------------------------------

describe("buildSubagentTool() toModelOutput", () => {
  it("formats a data-object part into a structured text result", () => {
    const toModelOutput = getToModelOutput(minimalConfig());
    expect(toModelOutput).toBeTypeOf("function");

    const message = {
      id: "msg-1",
      role: "assistant" as const,
      parts: [
        {
          type: "data-object",
          id: "data-1",
          data: {
            summary: "Investigated the build pipeline.",
            keyFindings: ["Vite config lives in vite.config.ts", "Tests run via vitest"],
            nextSteps: ["Add type checking", "Run full suite"],
          },
        },
      ],
    };

    const result = toModelOutput!({ output: message });

    expect(result.type).toBe("text");
    expect(result.value).toContain("[Subagent TestBot]");
    expect(result.value).toContain("Investigated the build pipeline.");
    expect(result.value).toContain("Vite config lives in vite.config.ts");
    expect(result.value).toContain("Add type checking");
  });

  it("falls back to text extraction when the data part fails schema validation", () => {
    const toModelOutput = getToModelOutput(minimalConfig());

    // A data part whose payload doesn't match the schema → must fall through.
    const message = {
      id: "msg-1",
      role: "assistant" as const,
      parts: [
        { type: "data-object", id: "data-1", data: { unexpected: true } },
        { type: "text", text: "Researched X. SUMMARY COMPLETE." },
      ],
    };

    const result = toModelOutput!({ output: message });

    // Backward-compatible path: text is returned as-is (completion suffix
    // preserved).
    expect(result.type).toBe("text");
    expect(result.value).toBe("Researched X. SUMMARY COMPLETE.");
  });

  it("preserves the existing SUMMARY COMPLETE. completion check (backward compat)", () => {
    const toModelOutput = getToModelOutput(minimalConfig());

    // Completed subagent summary — should pass through unchanged.
    const completedMessage = {
      id: "msg-1",
      role: "assistant" as const,
      parts: [{ type: "text", text: "Done. SUMMARY COMPLETE." }],
    };
    expect(toModelOutput!({ output: completedMessage }).value).toBe(
      "Done. SUMMARY COMPLETE.",
    );

    // Incomplete (no suffix) — should be flagged as partial.
    const partialMessage = {
      id: "msg-2",
      role: "assistant" as const,
      parts: [{ type: "text", text: "Fetching more data..." }],
    };
    const partialResult = toModelOutput!({ output: partialMessage });
    expect(partialResult.type).toBe("text");
    expect(partialResult.value).toContain("step limit");
    expect(partialResult.value).toContain("Fetching more data...");
  });

  it("reports honestly when there is no text or structured output", () => {
    const toModelOutput = getToModelOutput(minimalConfig());

    // No parts at all.
    const emptyMessage = {
      id: "msg-1",
      role: "assistant" as const,
      parts: [],
    };
    expect(toModelOutput!({ output: emptyMessage }).value).toBe(
      "Task failed or produced no text summary.",
    );

    // Undefined message (e.g. subagent crashed before emitting).
    expect(toModelOutput!({ output: undefined }).value).toBe(
      "Task failed or produced no text summary.",
    );
  });
});
