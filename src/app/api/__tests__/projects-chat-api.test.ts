import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
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
import { sqlite } from "@/db";

describe("Project Chat API Route", () => {
  let testDir: string;
  let proj: StoredProject;

  beforeEach(async () => {
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
});
