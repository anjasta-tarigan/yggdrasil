// @vitest-environment node
/**
 * Node environment, not the unit project's default jsdom: the route under
 * test statically imports `workflow/api`, and `@workflow/core` captures
 * `URL.prototype.href` at import. jsdom 30's `URL.prototype` exposes no own
 * `href` getter in this realm, so the import throws "Missing intrinsic
 * getter: href" before a single assertion runs. The node realm has the real
 * getter, and this suite needs no DOM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FIXTURES } from "@/lib/ai/web-provider/__fixtures__/deepseek-fixtures";
import { deepSeekHashV1, digestToHex, type PowChallenge } from "@/lib/ai/web-provider/pow";

function solvableChallenge(answer: number, difficulty: number): PowChallenge {
  const salt = "fixture-salt";
  const expireAt = Date.now() + 300_000;
  const prefix = `${salt}_${expireAt}_`;
  const challenge = digestToHex(deepSeekHashV1(new TextEncoder().encode(`${prefix}${answer}`)));
  return {
    algorithm: "DeepSeekHashV1",
    challenge,
    salt,
    signature: "sig",
    difficulty,
    expire_at: expireAt,
    target_path: "/api/v0/chat/completion",
  };
}

// Rule 06 (Environment Isolation): each test file gets its own SQLite
// database file so parallel workers don't race on shared rows.
vi.hoisted(() => {
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
import type { WebProviderSession } from "@/lib/ai/web-provider/types";

// The SQLite singleton is shared across suites running in the same worker pool,
// so we do NOT close the connection or unlink the database file in afterAll —
// doing so tears the database out from under sibling test files executed later
// in the same worker. Temporary files in os.tmpdir() are cleaned up by the OS.

const REJECTION_MESSAGE = "DeepSeek Web is not available in project chat.";
const SESSION_GATE_MESSAGE =
  "DeepSeek Web session expired or was rejected. Re-import the session token to continue.";
const STALE_SESSION_MESSAGE =
  "DeepSeek Web model data is stale. Refresh the discovered models in Settings → Providers to continue.";

function deepSeekStreamResponse(): Response {
  return new Response(
    [
      'data: {"v":{"response":{"message_id":1,"thinking_enabled":false,"fragments":[{"id":1,"type":"RESPONSE","content":""}]}}}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"Hello "}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"from "}\n\n',
      'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"DeepSeek"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }
  );
}

/**
 * A stored session fixture. Only `status` and the freshness timestamps are
 * read by the route gate, so the rest of the row is filled with plausible
 * values rather than driven through the real encrypt/store round-trip
 * (covered by `src/lib/ai/web-provider/__tests__/session-store.test.ts`).
 */
function storedSession(
  status: WebProviderSession["status"],
  overrides: Partial<Pick<WebProviderSession, "lastCheckedAt" | "capturedAt">> = {}
) {
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
    ...overrides,
  };
}

/** A timestamp safely past the 24h stale window the route enforces. */
function staleTimestamp(): Date {
  return new Date(Date.now() - 25 * 60 * 60 * 1000);
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

function mockChatLifecycle() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/v0/users/current")) {
      return new Response(JSON.stringify(FIXTURES.sessionSuccess), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/v0/chat_session/create")) {
      return new Response(JSON.stringify(FIXTURES.chatSessionCreate), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/v0/chat/create_pow_challenge")) {
      return new Response(
        JSON.stringify({ code: 0, biz_data: solvableChallenge(0, 16) }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return deepSeekStreamResponse();
  });
}

describe("Web Provider normal-chat session gate", () => {
  beforeEach(() => {
    getWebSessionMock.mockReset();
    resolveApiKeyMock.mockClear();
    resetStreamRegistry();
    // The kill switch is off by default (Spec §11.2) and the route reads it
    // through `refreshEnv()`, so every test that expects to reach the session
    // gate must turn it on explicitly. The flag-off cases below override it.
    vi.stubEnv("YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS", "true");
    // Install the stream-mocking spy in beforeEach with Phase A multi-step lifecycle handling
    mockChatLifecycle();
  });

  afterEach(() => {
    // Restore the `fetch` spy installed inside each `it` (and any other spy) so a
    // parallel worker that runs a sibling file with `vi.restoreAllMocks` in its
    // own afterEach cannot leave this suite's global fetch unwrapped. Without
    // this, `pnpm test` (maxWorkers: 2) fails while isolated `--maxWorkers=1`
    // passes — a cross-file spy-leak, not a product bug.
    vi.restoreAllMocks();
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

  const expectSuccessfulGeneration = async (res: Response) => {
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('"type":"text-delta"');
    expect(sse).toContain('"delta":"Hello "');
    expect(sse).toContain('"delta":"from "');
    expect(sse).toContain('"delta":"DeepSeek"');
    expect(sse).not.toContain("sk-session-token");
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

  it("never resolves an API key for a web-session provider and streams verified output", async () => {
    getWebSessionMock.mockResolvedValue(storedSession("verified"));

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    expect(resolveApiKeyMock).not.toHaveBeenCalled();
    await expectSuccessfulGeneration(res);
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
    await expectSuccessfulGeneration(res);
  });

  it("rejects an explicit web-session model whose discovery is stale", async () => {
    // Spec §8.5: stale model data expires after 24 hours and is then
    // unavailable for Web Provider chat.
    getWebSessionMock.mockResolvedValue(
      storedSession("verified", { lastCheckedAt: staleTimestamp() })
    );

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe(STALE_SESSION_MESSAGE);
    // Staleness is a model-data problem, not a credential problem: the route
    // must not reach for an API key, and the message must not tell the user to
    // re-import a token.
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
  });

  it("rejects a stale web-session default model with the refresh-models message", async () => {
    getWebSessionMock.mockResolvedValue(
      storedSession("verified", { lastCheckedAt: staleTimestamp() })
    );

    const res = await normalChatPost(normalChatReq({}));

    expect(res.status).toBe(401);
    expect(await res.text()).toBe(STALE_SESSION_MESSAGE);
    expect(resolveApiKeyMock).not.toHaveBeenCalled();
  });

  it("proceeds when a verified session is within the stale window", async () => {
    getWebSessionMock.mockResolvedValue(
      storedSession("verified", { lastCheckedAt: new Date() })
    );

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    await expectSuccessfulGeneration(res);
  });

  it("serves a chat whose history contains a prior tool call, flattened to text", async () => {
    // Spec §7.2 / B5: a chat that used tools before switching to DeepSeek Web
    // must stay usable — the tool call and its result are flattened into
    // transcript text, not rejected with unsupported_protocol.
    getWebSessionMock.mockResolvedValue(storedSession("verified"));
    const fetchSpy = mockChatLifecycle();

    const res = await normalChatPost(
      normalChatReq({
        model: "deepseek-web::deepseek-chat",
        messages: [
          { role: "user", parts: [{ type: "text", text: "search for X" }] },
          {
            role: "assistant",
            parts: [
              { type: "text", text: "Searching." },
              {
                type: "tool-web_search",
                toolCallId: "c1",
                state: "output-available",
                input: { q: "X" },
                output: { results: ["a", "b"] },
              },
            ],
          },
          { role: "user", parts: [{ type: "text", text: "summarize" }] },
        ],
      })
    );

    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).not.toContain("unsupported_protocol");
    expect(sse).toContain('"delta":"Hello "');

    // The upstream DeepSeek request carries text-only messages: the tool call
    // and its result were flattened, and no function definitions were sent.
    const deepSeekCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes("chat.deepseek.com/api/v0/chat/completion")
    );
    const deepSeekCall = deepSeekCalls.at(-1);
    const body = JSON.parse(
      (deepSeekCall?.[1] as RequestInit).body as string
    ) as { prompt: string };
    expect(body.prompt).toContain("[Tool invocation: web_search(");
    expect(body.prompt).toContain("[Tool result for web_search:");
    expect(body.prompt).not.toContain("tool-call");
  });

  it("falls back to a fresh capturedAt when lastCheckedAt is missing", async () => {
    // A session saved but never revalidated carries no lastCheckedAt; the
    // capture time is the freshness signal (Spec §8.5).
    getWebSessionMock.mockResolvedValue(
      storedSession("verified", { lastCheckedAt: null, capturedAt: new Date() })
    );

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    await expectSuccessfulGeneration(res);
  });

  it("treats a session with neither timestamp as stale", async () => {
    getWebSessionMock.mockResolvedValue(
      storedSession("verified", { lastCheckedAt: null, capturedAt: null })
    );

    const res = await normalChatPost(
      normalChatReq({ model: "deepseek-web::deepseek-chat" })
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe(STALE_SESSION_MESSAGE);
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
