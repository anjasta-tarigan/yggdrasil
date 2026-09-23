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

// The web-session provider the routes must resolve. Both the explicit-model
// path (loadRegistry) and the default-model path (getDefaultModelEntry)
// resolve through this entry, so a single fixture covers both.
//
// `apiKeyEnv` is deliberately set: a web-session provider is keyless, so a
// regression that resolves the API key before branching on `kind` would both
// call the key store and fail the named-key check — the spy assertion in the
// normal-chat suite pins exactly that.
const webSessionProvider = vi.hoisted(() => ({
  id: "deepseek-web",
  kind: "web-session" as const,
  name: "DeepSeek Web",
  baseUrl: "https://chat.deepseek.com",
  apiKeyEnv: "PROVIDER_DEEPSEEK_WEB_API_KEY",
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

// `resolveApiKey` is spied, not stubbed away: the normal-chat web-session
// path must never reach it, so a bare `vi.fn` records any call as a failure.
const resolveApiKeyMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/ai/provider-config/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/provider-config/store")>();
  return {
    ...actual,
    loadRegistry: vi.fn().mockResolvedValue({
      version: 1,
      providers: [webSessionProvider],
    }),
    resolveApiKey: resolveApiKeyMock,
  };
});

// The session store is mocked rather than driven through the real SQLite +
// APP_SECRET path: the gate under test is "read the session, branch on
// status", and the store's own encryption/round-trip is covered by
// `src/lib/ai/web-provider/__tests__/session-store.test.ts`.
const getWebSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ai/web-provider/session-store", () => ({
  getWebSession: getWebSessionMock,
}));

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
import { POST as normalChatPost } from "../chat/route";
import { createProject, saveProjectSession, deleteProjectSession, type StoredProject } from "@/lib/project-service";
import { resetStreamRegistry } from "@/lib/ai/stream-registry";
import { sqlite } from "@/db";
import type { WebProviderSession } from "@/lib/ai/web-provider/types";

// Both suites share the one route-level SQLite handle, so the database is
// closed once here, after every describe has finished — closing it inside a
// describe's `afterAll` would tear it out from under the suite that runs next.
afterAll(async () => {
  sqlite.close();
  await fs.rm(testDbPath, { force: true }).catch((err) =>
    console.debug("[web-provider-chat] Failed to delete test database:", err)
  );
});

const REJECTION_MESSAGE = "DeepSeek Web is not available in project chat.";
const SESSION_GATE_MESSAGE =
  "DeepSeek Web session expired or was rejected. Re-import the session token to continue.";

/**
 * A stored session fixture. Only `status` is read by the route gate, so the
 * rest of the row is filled with plausible values rather than driven through
 * the real encrypt/store round-trip (covered by
 * `src/lib/ai/web-provider/__tests__/session-store.test.ts`).
 */
function storedSession(status: WebProviderSession["status"]) {
  return {
    id: "wps-test-1",
    providerId: "deepseek-web",
    userToken: "sk-session-token",
    status,
    lastCheckedAt: new Date(),
    lastFailureCode: null,
    userAgentMode: "browser" as const,
    capturedAt: new Date(),
    sessionVersion: 1,
  };
}

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

describe("Web Provider normal-chat session gate", () => {
  beforeEach(() => {
    getWebSessionMock.mockReset();
    resolveApiKeyMock.mockClear();
    resetStreamRegistry();
    // The kill switch is off by default (Spec §11.2) and the route reads it
    // through `refreshEnv()`, so every test that expects to reach the session
    // gate must turn it on explicitly. The flag-off cases below override it.
    vi.stubEnv("YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetStreamRegistry();
  });

  const normalChatReq = (payload: Record<string, unknown>) =>
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
        ...payload,
      }),
    });

  /**
   * The verified-session path reaches `streamText` with the 9c stub, whose
   * `doStream` throws `WebProviderGenerationUnavailableError`. That surfaces
   * through the route's own SSE error channel (the same channel a real
   * upstream failure uses), not as a silent empty stream.
   */
  const expectStubGenerationFailure = async (res: Response) => {
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('"type":"error"');
    expect(sse).toContain("DeepSeek Web generation is unavailable for");
  };

  it("returns 401 with an actionable message when no session is stored", async () => {
    getWebSessionMock.mockResolvedValue(null);

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe(SESSION_GATE_MESSAGE);
  });

  it("returns 401 when the stored session is not verified", async () => {
    getWebSessionMock.mockResolvedValue(storedSession("expired"));

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe(SESSION_GATE_MESSAGE);
  });

  it("never resolves an API key for a web-session provider, even with a verified session", async () => {
    // A verified session passes the gate, so this request reaches model
    // construction — the point where a regression would resolve a key. The
    // provider fixture carries `apiKeyEnv` with no stored secret, so such a
    // regression fails the named-key check with 400 rather than reaching
    // generation. Asserting the generation failure is what proves the
    // keyless path actually got through.
    getWebSessionMock.mockResolvedValue(storedSession("verified"));

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    expect(resolveApiKeyMock).not.toHaveBeenCalled();
    await expectStubGenerationFailure(res);
  });

  it("gates the default-model branch: no session → 401 actionable message", async () => {
    // `model` is omitted, so `getDefaultModelEntry` (mocked to return the
    // web-session provider) actually runs and the default-model branch gates.
    getWebSessionMock.mockResolvedValue(null);

    const res = await normalChatPost(normalChatReq({}));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe(SESSION_GATE_MESSAGE);
    expect(getWebSessionMock).toHaveBeenCalledWith("deepseek-web");
  });

  it("gates the default-model branch: verified session reaches generation", async () => {
    getWebSessionMock.mockResolvedValue(storedSession("verified"));

    const res = await normalChatPost(normalChatReq({}));

    expect(resolveApiKeyMock).not.toHaveBeenCalled();
    await expectStubGenerationFailure(res);
  });

  it("rejects an explicit web-session model with feature_disabled when the flag is off", async () => {
    vi.stubEnv("YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS", "false");
    getWebSessionMock.mockResolvedValue(storedSession("verified"));

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(
      "Experimental Web Providers are currently disabled."
    );
    // Spec §11.2: no session secret is loaded unnecessarily.
    expect(getWebSessionMock).not.toHaveBeenCalled();
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects a web-session default model with feature_disabled when the flag is off", async () => {
    vi.stubEnv("YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS", "false");
    getWebSessionMock.mockResolvedValue(storedSession("verified"));

    const res = await normalChatPost(normalChatReq({}));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe(
      "Experimental Web Providers are currently disabled."
    );
    expect(getWebSessionMock).not.toHaveBeenCalled();
  });
});
