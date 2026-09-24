import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postDiscover } from "../deepseek/models/discover/route";
import { resetRateLimiterForTest } from "../guard";
import { resetDiscoveryCacheForTest } from "@/lib/ai/web-provider/discovery";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";
import { loadRegistry, saveRegistry, setProviderConfigPathsForTest } from "@/lib/ai/provider-config/store";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";
import { sqlite } from "@/db";
import {
  cleanupTestProviderRegistry,
  createTestProviderRegistryDir,
} from "@/test-utils/provider-registry";

vi.hoisted(() => {
  const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const dbPath = `${tmpDir}/ygg-discovery-route-${process.pid}-${Date.now()}.db`;
  process.env.DATABASE_PATH = dbPath;
  process.env.APP_SECRET = "test-secret-at-least-32-chars-long-12345";
  return dbPath;
});

const registryDir = createTestProviderRegistryDir("ygg-discovery-route");

/**
 * Route boundary for POST /api/web-providers/deepseek/models/discover
 * (Spec §6.6, §8.4, §14.2). Upstream discovery is mocked at the `fetch`
 * boundary: these tests bind route behavior, never DeepSeek payload truth.
 */

function discoverRequest(
  body: unknown = { force: false },
  init: { origin?: string | null; contentType?: string | null } = {}
): Request {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? "http://127.0.0.1:3000" : init.origin;
  const contentType =
    init.contentType === undefined ? "application/json" : init.contentType;
  if (origin) headers.Origin = origin;
  if (contentType) headers["Content-Type"] = contentType;

  return new Request("http://127.0.0.1:3000/api/web-providers/deepseek/models/discover", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Mock the adapter's declared catalog shape (a contract, not provider truth). */
function mockCatalog(models: Array<{ id: string; name: string }>, status = 200): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/api/v0/users/current")) {
      return new Response(
        JSON.stringify({ code: 0, data: { biz_data: { token: "test-access-token" } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({ code: 0, data: models }), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

async function seedRegistry(): Promise<void> {
  setProviderConfigPathsForTest(registryDir);
  const doc: RegistryDocument = {
    version: 1,
    providers: [
      {
        id: "deepseek-web",
        kind: "web-session",
        preset: "deepseek-web",
        name: "DeepSeek Web",
        baseUrl: "https://chat.deepseek.com",
        models: [],
      },
    ],
  };
  await saveRegistry(doc);
}

async function saveVerifiedSession(status: "verified" | "rejected" = "verified"): Promise<void> {
  const store = createSessionStore();
  await store.saveSession({
    providerId: "deepseek-web",
    userToken: "synthetic-token",
    userAgentMode: "server-default",
  });
  if (status !== "verified") await store.updateStatus("deepseek-web", status);
}

describe("POST /api/web-providers/deepseek/models/discover", () => {
  beforeEach(async () => {
    resetRateLimiterForTest();
    resetDiscoveryCacheForTest();
    sqlite.prepare("DELETE FROM web_provider_sessions").run();
    await seedRegistry();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTestProviderRegistry(registryDir);
    // We do NOT unlink the database file here: doing so tears the database
    // out from under sibling suites running in the same worker pool.
  });

  it("rejects discovery when no verified session exists", async () => {
    const res = await postDiscover(discoverRequest());

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("session_rejected");
  });

  it("rejects discovery when the stored session is not verified", async () => {
    await saveVerifiedSession("rejected");

    const res = await postDiscover(discoverRequest());

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("session_rejected");
  });

  it("rejects undeclared body fields so a client cannot smuggle a token or endpoint", async () => {
    await saveVerifiedSession();

    const res = await postDiscover(
      discoverRequest({ force: false, userToken: "smuggled", endpoint: "https://evil.example" })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("rejects a non-JSON content type", async () => {
    await saveVerifiedSession();

    const res = await postDiscover(discoverRequest({ force: false }, { contentType: "text/plain" }));

    expect(res.status).toBe(415);
  });

  it("rejects a cross-origin mutation", async () => {
    await saveVerifiedSession();

    const res = await postDiscover(
      discoverRequest({ force: false }, { origin: "https://evil.example" })
    );

    expect(res.status).toBe(403);
  });

  it("discovers through the saved session, persists the models, and never echoes the token", async () => {
    await saveVerifiedSession();
    mockCatalog([
      { id: "deepseek-chat", name: "DeepSeek Chat" },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    ]);

    const res = await postDiscover(discoverRequest({ force: false }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.provider).toBe("deepseek-web");
    expect(body.cache).toBe("fresh");
    expect(body.models.map((m: { modelId: string }) => m.modelId)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
    expect(JSON.stringify(body)).not.toContain("synthetic-token");

    // Models become selectable only after the registry write succeeds (Spec §8.4).
    const doc = await loadRegistry();
    expect(doc.providers[0].models.map((model) => model.modelId)).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
  });

  it("maps an upstream auth rejection to a 401 and persists nothing", async () => {
    await saveVerifiedSession();
    mockCatalog([], 401);

    const res = await postDiscover(discoverRequest({ force: false }));

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("session_rejected");
    const doc = await loadRegistry();
    expect(doc.providers[0].models).toEqual([]);
  });

  it("never sends a credential, cookie, or client User-Agent upstream", async () => {
    await saveVerifiedSession();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/v0/users/current")) {
        return new Response(
          JSON.stringify({ code: 0, data: { biz_data: { token: "resolved-access-token" } } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ code: 0, data: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    await postDiscover(discoverRequest({ force: false }));

    // Call 0 is userToken exchange; Call 1 is model discovery
    const [userUrl, userInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(userUrl)).toContain("/api/v0/users/current");
    expect(new Headers(userInit.headers).get("authorization")).toBe("Bearer synthetic-token");

    const [modelUrl, modelInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(String(modelUrl)).toContain("/api/v0/client/settings");
    const headers = new Headers(modelInit.headers);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer resolved-access-token");
  });

  it("advances the session freshness clock so a stale session recovers after discovery", async () => {
    // Spec §8.5: the chat gate refuses a session whose lastCheckedAt is older
    // than the stale window, and tells the user to refresh discovered models.
    // A successful discovery must therefore move that clock, or the promised
    // action could never clear the 401.
    await saveVerifiedSession();
    const store = createSessionStore();
    const staleSeconds = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    sqlite
      .prepare("UPDATE web_provider_sessions SET last_checked_at = ? WHERE provider_id = ?")
      .run(staleSeconds, "deepseek-web");

    mockCatalog([{ id: "deepseek-chat", name: "DeepSeek Chat" }]);
    const res = await postDiscover(discoverRequest({ force: false }));
    expect(res.status).toBe(200);

    const session = await store.getSession("deepseek-web");
    expect(session?.lastCheckedAt).toBeInstanceOf(Date);
    expect(session!.lastCheckedAt!.getTime() / 1000).toBeGreaterThan(staleSeconds);
  });
});
