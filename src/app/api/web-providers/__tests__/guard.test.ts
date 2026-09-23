import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateWebProviderRequest,
  checkRateLimit,
  resetRateLimiterForTest,
} from "../guard";

describe("Web Provider Management Guard", () => {
  beforeEach(() => {
    resetRateLimiterForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires application/json content type on mutating requests", () => {
    const req = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "text/plain",
      },
    });
    const res = validateWebProviderRequest(req, { requireJsonBody: true });
    expect(res).not.toBeNull();
    expect(res?.status).toBe(415);
  });

  it("rejects mutating requests with mismatched Origin or missing Origin/Referer", () => {
    const badOrigin = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://attacker.com",
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(badOrigin)?.status).toBe(403);

    const missingOrigin = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(missingOrigin)?.status).toBe(403);
  });

  it("accepts matching Referer when Origin is absent", () => {
    const refererReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Referer: "http://127.0.0.1:3000/settings",
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(refererReq)).toBeNull();
  });

  it("rejects mismatched or malformed Referer when Origin is absent", () => {
    const badReferer = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Referer: "http://attacker.com/page",
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(badReferer)?.status).toBe(403);

    const malformedReferer = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Referer: "not-a-valid-url",
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(malformedReferer)?.status).toBe(403);
  });

  it("allows loopback requests with matching Origin or remote requests with Bearer APP_SECRET", () => {
    const loopback = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(loopback)).toBeNull();
  });

  it("allows remote requests when valid Bearer APP_SECRET is supplied", () => {
    const testSecret = "test-secret-at-least-32-chars-long-12345";
    vi.stubEnv("APP_SECRET", testSecret);

    const remoteReq = new Request("https://remote-host.example.com/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "https://remote-host.example.com",
        Authorization: `Bearer ${testSecret}`,
        "Content-Type": "application/json",
      },
    });
    expect(validateWebProviderRequest(remoteReq)).toBeNull();
  });

  it("rejects remote requests without Bearer APP_SECRET with 401", () => {
    const remoteReq = new Request("https://remote-host.example.com/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "https://remote-host.example.com",
        "Content-Type": "application/json",
      },
    });
    const res = validateWebProviderRequest(remoteReq);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it("rejects remote requests with invalid Bearer APP_SECRET with 401", () => {
    const testSecret = "test-secret-at-least-32-chars-long-12345";
    vi.stubEnv("APP_SECRET", testSecret);

    const remoteReq = new Request("https://remote-host.example.com/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Origin: "https://remote-host.example.com",
        Authorization: "Bearer wrong-secret-token-that-does-not-match",
        "Content-Type": "application/json",
      },
    });
    const res = validateWebProviderRequest(remoteReq);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it("allows non-mutating GET requests without Origin or Referer", () => {
    const getReq = new Request("http://127.0.0.1:3000/api/web-providers", {
      method: "GET",
    });
    expect(validateWebProviderRequest(getReq)).toBeNull();
  });

  it("allows DELETE requests without body when requireJsonBody is not set", () => {
    const deleteReq = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "DELETE",
      headers: {
        Origin: "http://127.0.0.1:3000",
      },
    });
    expect(validateWebProviderRequest(deleteReq)).toBeNull();
  });

  it("enforces attempt rate limits with Retry-After", () => {
    const makeReq = () =>
      new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          "Content-Type": "application/json",
        },
      });

    // 5 attempts allowed in 15m window
    for (let i = 0; i < 5; i++) {
      expect(validateWebProviderRequest(makeReq(), { isCredentialCheck: true })).toBeNull();
    }

    // 6th attempt blocked with 429 and Retry-After
    const blocked = validateWebProviderRequest(makeReq(), { isCredentialCheck: true });
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeDefined();
  });

  it("supports standalone checkRateLimit function", () => {
    const now = 1000000;
    // 3 attempts in 10s window, 60s cooldown
    const res1 = checkRateLimit("client-1", 3, 10000, 60000, now);
    expect(res1.allowed).toBe(true);

    const res2 = checkRateLimit("client-1", 3, 10000, 60000, now + 1000);
    expect(res2.allowed).toBe(true);

    const res3 = checkRateLimit("client-1", 3, 10000, 60000, now + 2000);
    expect(res3.allowed).toBe(true);

    // 4th attempt exceeds maxAttempts=3
    const res4 = checkRateLimit("client-1", 3, 10000, 60000, now + 3000);
    expect(res4.allowed).toBe(false);
    expect(res4.retryAfterSeconds).toBe(60);

    // Subsequent call while in cooldown
    const res5 = checkRateLimit("client-1", 3, 10000, 60000, now + 10000);
    expect(res5.allowed).toBe(false);
    expect(res5.retryAfterSeconds).toBe(53); // 63s - 10s = 53s remaining

    // After cooldown passes
    const res6 = checkRateLimit("client-1", 3, 10000, 60000, now + 65000);
    expect(res6.allowed).toBe(true);
  });

  it("rejects with 404 feature_disabled in production when feature flag is disabled", () => {
    vi.stubEnv("NODE_ENV", "production");

    const req = new Request("http://127.0.0.1:3000/api/web-providers", {
      method: "GET",
    });
    const res = validateWebProviderRequest(req);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(404);
  });
});
