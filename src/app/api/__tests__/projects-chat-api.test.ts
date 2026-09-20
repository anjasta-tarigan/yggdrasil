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
// and every model-resolving request 500s. Seed an isolated registry in the
// test setup and swap the model builder for a scripted mock so the suite is
// hermetic (no dev registry, no network).
const testProviderDir = vi.hoisted(() => {
  const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  return `${tmpDir}/ygg-chat-providers-${process.pid}-${Date.now()}`;
});

// Controls the scripted model's behaviour per test. "text" streams a short
// reply; "timeout" throws an AI-SDK timeout DOMException so the harness
// loop's interceptor and the route's client-facing error mapper run.
const modelMode = vi.hoisted(() => ({ current: "text" as "text" | "timeout" }));

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  const { MockLanguageModelV4, simulateReadableStream } = await import("ai/test");
  const model = new MockLanguageModelV4({
    provider: "test",
    modelId: "test-model",
    doStream: async () => {
      if (modelMode.current === "timeout") {
        throw new DOMException(
          "first chunk timeout of 90000ms exceeded",
          "TimeoutError"
        );
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: "pong" },
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop" as const, raw: "stop" },
            },
          ],
        }),
      };
    },
  });
  return { ...actual, chatModelForEntry: () => model };
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
  setProviderConfigPathsForTest,
  saveRegistry,
} from "@/lib/ai/provider-config/store";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";
import { sqlite } from "@/db";

describe("Project Chat API Route", () => {
  let testDir: string;
  let proj: StoredProject;

  beforeAll(async () => {
    // Hermetic provider registry: a default ollama entry (no API key needed)
    // so default-model requests resolve, plus no extra providers so an
    // unknown provider ref still 400s. Without this the route 500s on any
    // machine that has no developer `data/providers.json`.
    await fs.mkdir(testProviderDir, { recursive: true });
    setProviderConfigPathsForTest(testProviderDir);
    const doc: RegistryDocument = {
      version: 1,
      providers: [
        {
          id: "test",
          kind: "ollama",
          name: "Test provider",
          baseUrl: "http://localhost:11434",
          models: [
            {
              modelId: "test-model",
              displayName: "Test Model",
              isDefault: true,
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
            {
              modelId: "no-tools-model",
              displayName: "No Tools Model",
              isDefault: false,
              capabilities: {
                contextWindow: null,
                maxOutputTokens: null,
                inputModalities: ["text"],
                outputModalities: ["text"],
                supportsToolCalls: false,
                supportsReasoning: null,
              },
              capabilitySources: {},
            },
          ],
        },
      ],
    };
    await saveRegistry(doc);
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
    await fs.rm(testProviderDir, { recursive: true, force: true }).catch((err) =>
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
});
