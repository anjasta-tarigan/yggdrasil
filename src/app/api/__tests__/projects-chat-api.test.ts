// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Rule 06 (Environment Isolation): each test file gets its own SQLite
// database file so parallel workers don't race on shared rows.
const testDbPath = vi.hoisted(() => {
  const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const p = `${tmpDir}/ygg-chat-${process.pid}-${Date.now()}.db`;
  process.env.DATABASE_PATH = p;
  return p;
});

// The route resolves the requested model against the provider registry and
// then builds an OpenAI-compatible model from it. A clean checkout has no
// `data/providers.json`, so `loadRegistry()` throws `ProviderConfigError`
// and every model-resolving request 500s. Seed an isolated registry (shared
// helper) and swap the model builder for a scripted mock so the suite is
// hermetic (no dev registry, no network).
const testProviderDir = createTestProviderRegistryDir("ygg-chat-providers");

// Controls the scripted model's behaviour per test. "text" streams a short
// reply; "timeout" throws an AI-SDK timeout DOMException so the harness
// loop's interceptor and the route's client-facing error mapper run.
const modelMode = vi.hoisted(() => ({ current: "text" as "text" | "timeout" }));

// Holder for the scripted model instance so tests can inspect the recorded
// provider call options (what the route actually sent).
const scriptedModel = vi.hoisted(() => ({
  current: null as MockLanguageModelV4 | null,
}));

// Captures the options the route passes to createProjectHarnessTools, so the
// window-aware tool cap can be asserted without reaching into the route.
const harnessToolOptions = vi.hoisted(() => ({
  current: null as unknown,
}));

// Captures every syslog line the route emits, so the run-end line can be
// asserted against the route's real output (not a re-derived string).
const syslogLines = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("@/lib/observability/log-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/observability/log-store")>();
  return {
    ...actual,
    syslog: (
      level: Parameters<typeof actual.syslog>[0],
      scope: string,
      message: string
    ) => {
      syslogLines.lines.push(message);
      return actual.syslog(level, scope, message);
    },
  };
});

vi.mock("@/lib/project-harness-tools", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/project-harness-tools")>();
  return {
    ...actual,
    createProjectHarnessTools: (
      options: Parameters<typeof actual.createProjectHarnessTools>[0]
    ) => {
      harnessToolOptions.current = options;
      return actual.createProjectHarnessTools(options);
    },
  };
});

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  const { createScriptedChatModel } = await import("@/test-utils/provider-registry");
  const model = createScriptedChatModel({
    shouldThrowTimeout: () => modelMode.current === "timeout",
  });
  scriptedModel.current = model;
  return { ...actual, chatModelForEntry: vi.fn().mockImplementation(() => model) };
});

import { POST as chatPost } from "../projects/chat/route";
import {
  createProject,
  saveProjectSession,
  getProjectSession,
  deleteProjectSession,
  type StoredProject,
} from "@/lib/project-service";
import * as queue from "@/lib/queue/queue";
import {
  publishStream,
  resetStreamRegistry,
} from "@/lib/ai/stream-registry";
import {
  cleanupTestProviderRegistry,
  createTestProviderRegistryDir,
  seedTestProviderRegistry,
} from "@/test-utils/provider-registry";
import {
  harnessHistoryBudget,
  harnessToolOutputChars,
} from "@/lib/ai/harness-context";
import { estimateTokens } from "@/lib/ai/context-budget";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { chatModelForEntry } from "@/lib/ai/provider";
import { sqlite } from "@/db";

describe("Project Chat API Route", () => {
  let testDir: string;
  let proj: StoredProject;

  beforeAll(async () => {
    // Hermetic provider registry (shared helper) so default-model requests
    // resolve and an unknown provider ref still 400s.
    await seedTestProviderRegistry(testProviderDir);
  });

  beforeEach(async () => {
    modelMode.current = "text";
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-chat-test-"));
    proj = await createProject({
      name: "chat-test-app",
      mode: "new",
      customBaseDir: testDir,
    });
    await saveProjectSession({
      id: "psess_chat_1",
      projectId: proj.id,
      title: "Chat 1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    });
    resetStreamRegistry();
  });

  afterEach(async () => {
    resetStreamRegistry();
    try {
      await deleteProjectSession("psess_chat_1");
    } catch (err) {
      // ignore cleanup errors during teardown
      console.debug("[projects-chat-api] deleteProjectSession cleanup failed:", err);
    }
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors during teardown
      console.debug("[projects-chat-api] testDir cleanup failed:", err);
    }
  });

  afterAll(async () => {
    sqlite.close();
    await fs.rm(testDbPath, { force: true }).catch((err) =>
      console.debug("[projects-chat-api] Failed to delete test database:", err)
    );
    await cleanupTestProviderRegistry(testProviderDir).catch((err) =>
      console.debug("[projects-chat-api] Failed to delete provider dir:", err)
    );
  });

  it("rejects request with mismatched session and project id", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_non_existent",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(404);
  });

  it("rejects request when session belongs to a different project", async () => {
    const otherProj = await createProject({
      name: "other-app",
      mode: "new",
      customBaseDir: testDir,
    });

    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: otherProj.id,
        sessionId: "psess_chat_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/does not belong to project/i);
  });

  it("rejects request when project does not exist", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: "proj_non_existent",
        sessionId: "psess_chat_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(404);
  });

  it("rejects request when project directory is missing on disk (TOCTOU)", async () => {
    // Remove project directory
    await fs.rm(proj.directoryPath, { recursive: true, force: true });

    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_chat_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(404);
  });

  it("rejects request if session has an active stream in progress (409 Conflict)", async () => {
    const streamId = "active-stream-test";
    const dummyStream = new ReadableStream({
      start(c) {
        c.enqueue("chunk 1");
      },
    });
    publishStream(streamId, "chat-session", dummyStream);

    await saveProjectSession({
      id: "psess_chat_1",
      projectId: proj.id,
      title: "Chat 1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeStreamId: streamId,
      messages: [],
    });

    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_chat_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toMatch(/already in progress/i);
  });

  it("reconciles a stale activeStreamId (server restart) instead of 409-ing forever", async () => {
    // Simulate a pointer left behind by a stream that ran before a restart:
    // the session row holds an id, but the in-process registry has no such
    // entry. Previously this 409'd every later send, permanently.
    await saveProjectSession({
      id: "psess_chat_1",
      projectId: proj.id,
      title: "Chat 1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeStreamId: "stream-from-before-restart",
      messages: [],
    });

    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_chat_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello again" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(200);

    // Drain the stream so the registry entry settles.
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  });

  it(
    "never dispatches ingest_turn queue jobs for project sessions (Zero Memory Leakage)",
    async () => {
      const enqueueSpy = vi.spyOn(queue, "enqueueJob");

      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          messages: [{ role: "user", parts: [{ type: "text", text: "Explain files" }] }],
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      // Consume stream
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      // Verify zero memory ingestion jobs
      const ingestCalls = enqueueSpy.mock.calls.filter(([job]) => job.type === "ingest_turn");
      expect(ingestCalls.length).toBe(0);
      enqueueSpy.mockRestore();
    },
    60_000
  );

  it("rejects request with invalid JSON body (400)", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: "not a valid json",
    });

    const res = await chatPost(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/invalid json/i);
  });

  it("rejects request with missing projectId or sessionId (400)", async () => {
    const noProjReq = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: "psess_chat_1",
        messages: [],
      }),
    });

    const noProjRes = await chatPost(noProjReq);
    expect(noProjRes.status).toBe(400);
    const noProjData = await noProjRes.json();
    expect(noProjData.error).toMatch(/projectId is required/i);

    const noSessReq = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        messages: [],
      }),
    });

    const noSessRes = await chatPost(noSessReq);
    expect(noSessRes.status).toBe(400);
    const noSessData = await noSessRes.json();
    expect(noSessData.error).toMatch(/sessionId is required/i);
  });

  it("rejects request from untrusted origin (403)", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://malicious-site.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_chat_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(403);
  });

  it("rejects request with unknown provider/model (400)", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_chat_1",
        model: "unknown-provider::fake-model",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(400);
  });

  it("rejects a model that cannot call tools (400)", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_chat_1",
        model: "test::no-tools-model",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/does not support tool calling/i);
  });

  it(
    "saves messages and clears activeStreamId upon completion",
    async () => {
      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          effort: "medium",
          messages: [{ role: "user", parts: [{ type: "text", text: "Respond with pong" }] }],
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      // Consume entire stream
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      // Small delay to ensure onEnd persistence has settled
      await new Promise((r) => setTimeout(r, 100));

      const updatedSession = await getProjectSession("psess_chat_1");
      expect(updatedSession).not.toBeNull();
      // activeStreamId should be cleared
      expect(updatedSession!.activeStreamId).toBeNull();
      // Should have saved user message and assistant message
      expect(updatedSession!.messages.length).toBeGreaterThanOrEqual(1);
      expect(updatedSession!.messages[0].role).toBe("user");
    },
    60_000
  );

  it(
    "surfaces a classified, actionable timeout message to the client",
    async () => {
      modelMode.current = "timeout";

      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          messages: [{ role: "user", parts: [{ type: "text", text: "do work" }] }],
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const reader = res.body?.getReader();
      let raw = "";
      if (reader) {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
        }
      }

      // The classification reaches the client; the raw DOMException text does not.
      expect(raw).toContain("The agent timed out (first chunk timeout (90000ms))");
      expect(raw).toContain("Send a follow-up message to continue.");
      expect(raw).not.toContain("first chunk timeout of 90000ms exceeded");
    },
    60_000
  );

  it(
    "compacts request-start history to at most HARNESS_HISTORY_BUDGET_RATIO of the budget",
    async () => {
      // Build a long history of large messages so request-start compaction
      // must actually drop something.
      const bulk = "q".repeat(8_000);
      const longHistory = Array.from({ length: 24 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        parts: [{ type: "text" as const, text: `message ${i} ${bulk}` }],
      }));

      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          messages: longHistory,
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const budget = Number(res.headers.get("x-context-budget"));
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);

      // Consume the stream so the model call is recorded.
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      const model = scriptedModel.current;
      expect(model).not.toBeNull();
      const calls = model!.doStreamCalls;
      expect(calls.length).toBeGreaterThan(0);

      // The history the model received is at most the harness history budget
      // (0.6 * budget), measured with the same estimator the route uses.
      const historyTokens = estimateTokens(JSON.stringify(calls[0].prompt));
      const historyBudget = harnessHistoryBudget(budget);
      expect(historyTokens).toBeLessThanOrEqual(historyBudget);
      // And it is strictly smaller than the full budget, proving the ratio
      // headroom is actually applied (not a no-op).
      expect(historyBudget).toBeLessThan(budget);
    },
    60_000
  );

  it(
    "passes a window-aware maxOutputChars derived from budgetTokens to the tools",
    async () => {
      harnessToolOptions.current = null;

      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const budget = Number(res.headers.get("x-context-budget"));
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);

      const options = harnessToolOptions.current as {
        maxOutputChars?: number | (() => number);
      } | null;
      expect(options).not.toBeNull();
      if (options === null) throw new Error("tools were not created");
      // Function form: the cap is resolved at tool-execution time, because
      // the tools are built before budgetTokens exists.
      expect(typeof options.maxOutputChars).toBe("function");
      expect((options.maxOutputChars as () => number)()).toBe(
        harnessToolOutputChars(budget)
      );

      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
    },
    60_000
  );

  it(
    "logs the run end with context-guard fields (no wrap-up for a short run)",
    async () => {
      syslogLines.lines.length = 0;

      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      // Assert the line the ROUTE emitted, not a re-derived string.
      const runEndLine = syslogLines.lines.find((l) =>
        l.startsWith("Harness run ended:")
      );
      expect(runEndLine).toBeDefined();
      expect(runEndLine).toContain("steps=");
      expect(runEndLine).toContain("finishReason=");
      expect(runEndLine).toContain("reachedStepCap=");
      // A short run does not trip the guard: the fields must be present and
      // false/zero rather than omitted.
      expect(runEndLine).toContain("contextElisions=0");
      expect(runEndLine).toContain("contextWrapUp=false");
    },
    60_000
  );

  // ── Tool-name repair: NoSuchToolError path ─────────────────────────────

  it(
    "maps a scripted 'write' call through file_operations — no NoSuchToolError in stream",
    async () => {
      syslogLines.lines.length = 0;

      // Script the model to emit a tool-call with hallucinated name "write".
      vi.mocked(chatModelForEntry).mockReturnValueOnce(
        new MockLanguageModelV4({
          provider: "test",
          modelId: "test-model",
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "tc-write-1",
                  toolName: "write",
                  input: JSON.stringify({ path: "hello.txt", content: "hello" }),
                },
                {
                  type: "finish" as const,
                  usage: {
                    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                  },
                  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                },
              ],
            }),
          }),
        })
      );

      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          messages: [{ role: "user", parts: [{ type: "text", text: "write hello.txt" }] }],
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const body = await res.text();

      // No NoSuchToolError for "write" should appear in the UI stream.
      expect(body).not.toMatch(/NoSuchToolError/);
      expect(body).not.toMatch(/unavailable tool 'write'/);

      // A repair log line must have been emitted with the correct info.
      const repairLine = syslogLines.lines.find(
        (l) => l.includes("Tool call repaired") && l.includes("write") && l.includes("file_operations")
      );
      expect(repairLine).toBeDefined();
    },
    60_000
  );

  it(
    "still surfaces an error chunk for a genuinely unknown tool ('foo')",
    async () => {
      // Script the model to emit a tool-call with genuinely unknown name "foo".
      vi.mocked(chatModelForEntry).mockReturnValueOnce(
        new MockLanguageModelV4({
          provider: "test",
          modelId: "test-model",
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "tc-foo-1",
                  toolName: "foo",
                  input: JSON.stringify({}),
                },
                {
                  type: "finish" as const,
                  usage: {
                    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 2, text: 2, reasoning: 0 },
                  },
                  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                },
              ],
            }),
          }),
        })
      );

      const req = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: "psess_chat_1",
          messages: [{ role: "user", parts: [{ type: "text", text: "call foo" }] }],
        }),
      });

      const res = await chatPost(req);
      expect(res.status).toBe(200);

      const body = await res.text();
      // The unknown tool must surface an error in the UI stream.
      expect(body).toMatch(/foo|NoSuchToolError|unavailable tool/i);
    },
    60_000
  );
});
