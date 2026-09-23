// @vitest-environment node
/**
 * Node environment, not the unit project's default jsdom: the route under
 * test statically imports `workflow/api`, and `@workflow/core` captures
 * `URL.prototype.href` at import. jsdom 30's `URL.prototype` exposes no own
 * `href` getter in this realm, so the import throws "Missing intrinsic
 * getter: href" before a single assertion runs. The node realm has the real
 * getter, and this suite needs no DOM.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Rule 06 (Environment Isolation): each test file gets its own SQLite
// database file so parallel workers don't race on shared rows.
const testDbPath = vi.hoisted(() => {
  const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const p = `${tmpDir}/ygg-web-provider-chat-${process.pid}-${Date.now()}.db`;
  process.env.DATABASE_PATH = p;
  return p;
});

// The web-session provider the route must reject. Both the explicit-model
// path (loadRegistry) and the default-model path (getDefaultModelEntry)
// resolve through this entry, so a single fixture covers both.
const webSessionProvider = vi.hoisted(() => ({
  id: "deepseek-web",
  kind: "web-session" as const,
  name: "DeepSeek Web",
  baseUrl: "https://chat.deepseek.com",
  models: [
    {
      modelId: "deepseek-chat",
      displayName: "DeepSeek Chat",
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
  ],
}));

vi.mock("@/lib/ai/provider-config/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/provider-config/store")>();
  return {
    ...actual,
    loadRegistry: vi.fn().mockResolvedValue({
      version: 1,
      providers: [webSessionProvider],
    }),
  };
});

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return {
    ...actual,
    getDefaultModelEntry: vi.fn().mockResolvedValue({
      provider: webSessionProvider,
      model: webSessionProvider.models[0],
    }),
  };
});

import { POST as chatPost } from "../projects/chat/route";
import { createProject, saveProjectSession, deleteProjectSession, type StoredProject } from "@/lib/project-service";
import { resetStreamRegistry } from "@/lib/ai/stream-registry";
import { sqlite } from "@/db";

const REJECTION_MESSAGE = "DeepSeek Web is not available in project chat.";

describe("Web Provider project-chat exclusion", () => {
  let testDir: string;
  let proj: StoredProject;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-web-provider-chat-"));
    proj = await createProject({
      name: "web-provider-chat-app",
      mode: "new",
      customBaseDir: testDir,
    });
    await saveProjectSession({
      id: "psess_web_1",
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
      await deleteProjectSession("psess_web_1");
    } catch (err) {
      console.debug("[web-provider-chat] deleteProjectSession cleanup failed:", err);
    }
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (err) {
      console.debug("[web-provider-chat] testDir cleanup failed:", err);
    }
  });

  afterAll(async () => {
    sqlite.close();
    await fs.rm(testDbPath, { force: true }).catch((err) =>
      console.debug("[web-provider-chat] Failed to delete test database:", err)
    );
  });

  it("rejects an explicit web-session model with a 400 and the exact message", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_web_1",
        model: "deepseek-web::deepseek-chat",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe(REJECTION_MESSAGE);
  });

  it("rejects a web-session default model with a 400 and the exact message", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_web_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe(REJECTION_MESSAGE);
  });
});
