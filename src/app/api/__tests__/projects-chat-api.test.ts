import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../projects/chat/route";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import path from "node:path";
import os from "node:os";

let sqlite: Database.Database;
let testDb: any;
const tempTestDir = path.join(os.tmpdir(), "yggdrasil-chat-test-" + Date.now());

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

const { mockLanguageModel } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MockLanguageModelV3, convertArrayToReadableStream } = require("ai/test");
  const model = new MockLanguageModelV3({
    doStream: async (options: any) => {
      if ((globalThis as any).__capturedCalls) {
        (globalThis as any).__capturedCalls.push(options);
      }
      return {
        stream: convertArrayToReadableStream([
          { type: "response-metadata", id: "1", modelId: "mock-model" },
          { type: "text-start", id: "1" },
          { type: "text-delta", id: "1", delta: "<think>Analyzing workspace</think>Ready to help" },
          { type: "text-end", id: "1" },
          {
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheCreation: 0 },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            },
          },
        ]),
      };
    },
  });
  return { mockLanguageModel: model };
});

vi.mock("@/lib/ai/provider", () => ({
  defaultModel: mockLanguageModel,
  defaultModelId: "mock-model-id",
  llm: {
    chatModel: vi.fn().mockReturnValue(mockLanguageModel),
  },
  sanitizeProviderOverrides: vi.fn().mockReturnValue(undefined),
}));

describe("Projects Chat API Route", () => {
  beforeEach(() => {
    (globalThis as any).__capturedCalls = [];
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("rejects chat request when project is untrusted with 403", async () => {
    testDb
      .insert(schema.projects)
      .values({
        id: "proj_untrusted_1",
        name: "Untrusted Project",
        directoryPath: tempTestDir,
        trusted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const req = new Request("http://localhost/api/projects/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "proj_untrusted_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("Project directory is not trusted/approved");
  });

  it("rejects non-existent project with 404", async () => {
    const req = new Request("http://localhost/api/projects/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "nonexistent",
        messages: [],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("accepts trusted project chat requests, configures reasoning options, and pipes through stream transformation", async () => {
    testDb
      .insert(schema.projects)
      .values({
        id: "proj_trusted_1",
        name: "Trusted Project",
        directoryPath: tempTestDir,
        trusted: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const abortController = new AbortController();
    const req = new Request("http://localhost/api/projects/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        projectId: "proj_trusted_1",
        model: "claude-3-7-sonnet-20250219",
        messages: [{ role: "user", parts: [{ type: "text", text: "Inspect repo structure" }] }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
    }
    const fullOutput = chunks.join("");
    expect(fullOutput).toContain("data: ");

    const calls = (globalThis as any).__capturedCalls;
    expect(calls.length).toBeGreaterThan(0);
    const callArgs = calls[0];
    expect(callArgs.providerOptions).toMatchObject({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16000 } },
    });
    expect(callArgs.abortSignal).toBe(req.signal);
    const toolNames = callArgs.tools.map((t: any) => t.name);
    expect(toolNames).toContain("projectBash");
    expect(toolNames).toContain("projectReadFile");
    expect(toolNames).toContain("projectWriteFile");
    expect(toolNames).toContain("projectListFiles");
  });
});
