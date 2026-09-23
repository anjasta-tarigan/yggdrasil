import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";

const testDbPath = vi.hoisted(() => {
  const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const p = `${tmpDir}/ygg-web-prov-${process.pid}-${Date.now()}.db`;
  process.env.DATABASE_PATH = p;
  process.env.APP_SECRET = "test-secret-at-least-32-chars-long-12345";
  return p;
});

import { GET as getCatalog } from "../route";
import { POST as postCheck } from "../deepseek/session/check/route";
import { POST as postSave, DELETE as deleteSession } from "../deepseek/session/route";
import { POST as postRevalidate } from "../deepseek/session/revalidate/route";
import { resetRateLimiterForTest, acquireCheckSlot, releaseCheckSlot } from "../guard";
import { sqlite } from "@/db";

/** Upstream validation is mocked: these tests bind route behavior, not DeepSeek truth. */
function mockUpstreamValidation(status = 200, body: unknown = { code: 0, data: {} }): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
}

describe("Web Provider Session Routes", () => {
  beforeEach(() => {
    resetRateLimiterForTest();
    sqlite.prepare("DELETE FROM web_provider_sessions").run();
    mockUpstreamValidation();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await fs.unlink(testDbPath);
      await fs.unlink(`${testDbPath}-wal`).catch(() => {});
      await fs.unlink(`${testDbPath}-shm`).catch(() => {});
    } catch {
      // ignore
    }
  });

  it("GET /api/web-providers returns redacted catalog without secrets", async () => {
    const res = await getCatalog(new Request("http://127.0.0.1:3000/api/web-providers"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.providers).toBeDefined();
    expect(data.providers[0].id).toBe("deepseek-web");
    expect(data.providers[0].experimental).toBe(true);
    expect(data.providers[0].session.status).toBeDefined();
    expect(data.providers[0]).not.toHaveProperty("encryptedPayload");
    expect(data.providers[0]).not.toHaveProperty("userToken");
  });

  it("POST /check rejects tokens with control characters and enforces length limits", async () => {
    const invalidReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "line1\nline2", userAgentMode: "server-default" }),
    });

    const res = await postCheck(invalidReq);
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe("invalid_request");
  });

  it("POST /check rejects undeclared candidate fields", async () => {
    const invalidReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "valid-token", endpoint: "https://evil.example" }),
    });

    const res = await postCheck(invalidReq);
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe("invalid_request");
  });

  it("POST /check rejects oversized request bodies", async () => {
    const oversizedReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
        "Content-Length": "16385",
      },
      body: JSON.stringify({ userToken: "valid-token" }),
    });

    const res = await postCheck(oversizedReq);
    expect(res.status).toBe(413);
    const err = await res.json();
    expect(err.code).toBe("invalid_request");
  });

  it("POST /check rejects tokens exceeding max length", async () => {
    const invalidReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "a".repeat(8193), userAgentMode: "server-default" }),
    });

    const res = await postCheck(invalidReq);
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe("invalid_request");
  });

  it("POST /check rejects invalid JSON body", async () => {
    const invalidReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: "{ not json",
    });

    const res = await postCheck(invalidReq);
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.code).toBe("invalid_request");
  });

  it("POST /check verifies candidate successfully and strips userToken= prefix", async () => {
    const req = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "userToken=valid-test-token-12345", userAgentMode: "server-default" }),
    });

    const res = await postCheck(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.provider).toBe("deepseek-web");
    expect(data.status).toBe("verified");
  });

  it("POST /check rejects a candidate the adapter rejects instead of reporting verified", async () => {
    mockUpstreamValidation(401, { code: 40100, msg: "Unauthorized" });

    const req = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "invalid-token", userAgentMode: "server-default" }),
    });

    const res = await postCheck(req);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe("session_rejected");
    expect(data.message).toBe("The session was rejected. Your credentials were not saved.");
    // A rejected check persists nothing (Spec §5.3).
    const rows = sqlite.prepare("SELECT COUNT(*) AS count FROM web_provider_sessions").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("POST /check releases its concurrency slots after an adapter failure", async () => {
    mockUpstreamValidation(503, { code: 50000, msg: "upstream unavailable" });
    const ipKey = "ip:127.0.0.1";
    const req = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ userToken: "token-slot-release", userAgentMode: "server-default" }),
    });

    const res = await postCheck(req);
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("protocol_error");
    // The finally block released every slot, so the next check is not blocked.
    expect(acquireCheckSlot(ipKey)).toBe(true);
    expect(acquireCheckSlot(ipKey)).toBe(true);
    expect(acquireCheckSlot(ipKey)).toBe(true);
    releaseCheckSlot(ipKey);
    releaseCheckSlot(ipKey);
    releaseCheckSlot(ipKey);
  });

  it("POST /check enforces concurrency slots and releases them after execution", async () => {
    const ipKey = "ip:127.0.0.1";
    // Artificially acquire slots up to maximum (3)
    expect(acquireCheckSlot(ipKey)).toBe(true);
    expect(acquireCheckSlot(ipKey)).toBe(true);
    expect(acquireCheckSlot(ipKey)).toBe(true);

    const req = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ userToken: "token-concurrent", userAgentMode: "server-default" }),
    });

    const res = await postCheck(req);
    expect(res.status).toBe(429);

    // Release slots
    releaseCheckSlot(ipKey);
    releaseCheckSlot(ipKey);
    releaseCheckSlot(ipKey);

    const res2 = await postCheck(req);
    expect(res2.status).toBe(200);
  });

  it("POST /session saves encrypted session and updates catalog view", async () => {
    const saveReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userToken: "userToken=sk-my-secret-deepseek-token",
        userAgentMode: "custom",
        userAgent: "CustomUserAgent/2.0",
      }),
    });

    const saveRes = await postSave(saveReq);
    expect(saveRes.status).toBe(200);
    const saveData = await saveRes.json();
    expect(saveData.ok).toBe(true);
    expect(saveData.provider).toBe("deepseek-web");
    expect(saveData.status).toBe("verified");
    expect(saveData.lastCheckedAt).toBeDefined();

    // Verify GET /api/web-providers reflects verified session without leaking secrets
    const catRes = await getCatalog(new Request("http://127.0.0.1:3000/api/web-providers"));
    const catData = await catRes.json();
    expect(catData.providers[0].session.status).toBe("verified");
    expect(catData.providers[0].session.userAgentMode).toBe("custom");
    expect(catData.providers[0].session).not.toHaveProperty("userToken");
    expect(catData.providers[0].session).not.toHaveProperty("encryptedPayload");
  });

  it("POST /session revalidates server-side and persists nothing when the adapter rejects", async () => {
    mockUpstreamValidation(403, { code: 40300, msg: "Forbidden" });

    const saveReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "sk-rejected-token", userAgentMode: "server-default" }),
    });

    const res = await postSave(saveReq);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.code).toBe("session_rejected");

    // The client cannot skip validation: no row was written.
    const rows = sqlite.prepare("SELECT COUNT(*) AS count FROM web_provider_sessions").get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("POST /session/revalidate marks a rejected session and reports the closed failure", async () => {
    // Save with a valid upstream, then have the upstream reject on revalidation.
    const saveReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
      body: JSON.stringify({ userToken: "sk-revalidate-reject", userAgentMode: "server-default" }),
    });
    expect((await postSave(saveReq)).status).toBe(200);

    mockUpstreamValidation(401, { code: 40100, msg: "Unauthorized" });

    const revalidateReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/revalidate", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" },
    });
    const res = await postRevalidate(revalidateReq);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("session_rejected");

    // Only safe status metadata changed; the credential was not re-imported.
    const row = sqlite
      .prepare("SELECT status, last_failure_code AS failureCode FROM web_provider_sessions WHERE provider_id = ?")
      .get("deepseek-web") as { status: string; failureCode: string | null };
    expect(row.status).toBe("rejected");
    expect(row.failureCode).toBe("session_rejected");
  });

  it("POST /session/revalidate re-checks existing session or returns 401 if missing", async () => {
    // 1. Revalidate with no session returns 401 session_rejected
    const req1 = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/revalidate", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
    });
    const res1 = await postRevalidate(req1);
    expect(res1.status).toBe(401);
    const err1 = await res1.json();
    expect(err1.code).toBe("session_rejected");

    // 2. Save session first
    const saveReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userToken: "sk-revalidate-test-token",
        userAgentMode: "browser",
      }),
    });
    await postSave(saveReq);

    // 3. Revalidate existing session succeeds
    const req2 = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/revalidate", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
    });
    const res2 = await postRevalidate(req2);
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.ok).toBe(true);
    expect(data2.status).toBe("verified");
  });

  it("DELETE /session deletes the session cleanly and idempotently", async () => {
    // Save session
    const saveReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userToken: "sk-to-delete",
        userAgentMode: "browser",
      }),
    });
    await postSave(saveReq);

    // DELETE session
    const delReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "DELETE",
      headers: {
        Origin: "http://127.0.0.1:3000",
      },
    });
    const delRes = await deleteSession(delReq);
    expect(delRes.status).toBe(200);
    const delData = await delRes.json();
    expect(delData.ok).toBe(true);
    expect(delData.status).toBe("not-configured");

    // Catalog reflects not-configured
    const catRes = await getCatalog(new Request("http://127.0.0.1:3000/api/web-providers"));
    const catData = await catRes.json();
    expect(catData.providers[0].session.status).toBe("not-configured");

    // Repeat DELETE is idempotent
    const delRes2 = await deleteSession(delReq);
    expect(delRes2.status).toBe(200);
  });

  it("rejects mutating requests with mismatched Origin (CSRF protection)", async () => {
    const badReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://evil-attacker.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userToken: "token" }),
    });

    const res = await postCheck(badReq);
    expect(res.status).toBe(403);
  });
});
