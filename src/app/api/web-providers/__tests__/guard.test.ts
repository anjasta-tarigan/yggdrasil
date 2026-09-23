import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  validateWebProviderRequest,
  checkRateLimit,
  checkCredentialRateLimit,
  acquireCheckSlot,
  releaseCheckSlot,
  resetRateLimiterForTest,
  isLocalRequest,
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

  it("requires application/json content type for PUT requests by default", () => {
    const req = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session", {
      method: "PUT",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "text/plain",
      },
    });
    const res = validateWebProviderRequest(req);
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

  it("prevents authentication bypass via client-controlled Host header with remote proxy headers", () => {
    // Remote request spoofing Host: localhost but carrying remote x-forwarded-for
    const spoofedXff = new Request("http://localhost:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Host: "localhost:3000",
        "x-forwarded-for": "203.0.113.195, 127.0.0.1",
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
    });
    expect(isLocalRequest(spoofedXff)).toBe(false);
    expect(validateWebProviderRequest(spoofedXff)?.status).toBe(401);

    // Remote request spoofing Host: 127.0.0.1 with x-real-ip
    const spoofedRealIp = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3000",
        "x-real-ip": "198.51.100.22",
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
    });
    expect(isLocalRequest(spoofedRealIp)).toBe(false);
    expect(validateWebProviderRequest(spoofedRealIp)?.status).toBe(401);

    // Remote request with RFC 7239 forwarded header
    const spoofedForwarded = new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3000",
        forwarded: "for=198.51.100.22;proto=http",
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
    });
    expect(isLocalRequest(spoofedForwarded)).toBe(false);
    expect(validateWebProviderRequest(spoofedForwarded)?.status).toBe(401);
  });

  it("allows non-browser remote mutating requests without Origin/Referer when valid Bearer APP_SECRET is provided", () => {
    const testSecret = "test-secret-at-least-32-chars-long-12345";
    vi.stubEnv("APP_SECRET", testSecret);

    const cliRemoteReq = new Request("https://remote-host.example.com/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testSecret}`,
        "Content-Type": "application/json",
      },
    });
    // Should bypass CSRF check because caller is authenticated non-browser remote tool
    expect(validateWebProviderRequest(cliRemoteReq)).toBeNull();
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

    // 5 attempts allowed in 15m window per IP
    for (let i = 0; i < 5; i++) {
      expect(validateWebProviderRequest(makeReq(), { isCredentialCheck: true })).toBeNull();
    }

    // 6th attempt blocked with 429 and Retry-After
    const blocked = validateWebProviderRequest(makeReq(), { isCredentialCheck: true });
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeDefined();
  });

  it("enforces credential rate limits across different IPs", () => {
    const credKey = "hash-token-user-123";
    const testSecret = "test-secret-at-least-32-chars-long-12345";
    vi.stubEnv("APP_SECRET", testSecret);

    // 10 attempts allowed for this credential in 15m window
    for (let i = 0; i < 10; i++) {
      const req = new Request("https://remote-host.example.com/api/web-providers/deepseek/session/check", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${testSecret}`,
          "Content-Type": "application/json",
          "x-forwarded-for": `198.51.100.${i + 1}`, // different remote IP per request
        },
      });
      expect(validateWebProviderRequest(req, { isCredentialCheck: true, credentialKey: credKey })).toBeNull();
    }

    // 11th attempt for the same credential blocked with 429
    const req11 = new Request("https://remote-host.example.com/api/web-providers/deepseek/session/check", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testSecret}`,
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.99",
      },
    });
    const blocked = validateWebProviderRequest(req11, { isCredentialCheck: true, credentialKey: credKey });
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBeDefined();
  });

  it("enforces concurrency limits per IP and credential", () => {
    const ipKey = "ip:local-ip";
    expect(acquireCheckSlot(ipKey)).toBe(true);
    expect(acquireCheckSlot(ipKey)).toBe(true);
    expect(acquireCheckSlot(ipKey)).toBe(true);
    // 4th concurrent acquisition rejected
    expect(acquireCheckSlot(ipKey)).toBe(false);

    const makeReq = () =>
      new Request("http://127.0.0.1:3000/api/web-providers/deepseek/session/check", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:3000",
          "Content-Type": "application/json",
        },
      });

    const blocked = validateWebProviderRequest(makeReq(), { isCredentialCheck: true });
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("Retry-After")).toBe("60");

    // Release one slot and request should proceed
    releaseCheckSlot(ipKey);
    expect(validateWebProviderRequest(makeReq(), { isCredentialCheck: true })).toBeNull();
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

  it("supports standalone checkCredentialRateLimit function", () => {
    const now = 2000000;
    // 10 attempts allowed per credential
    for (let i = 0; i < 10; i++) {
      expect(checkCredentialRateLimit("token-xyz", now + i * 100).allowed).toBe(true);
    }
    const blocked = checkCredentialRateLimit("token-xyz", now + 1500);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeDefined();
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
