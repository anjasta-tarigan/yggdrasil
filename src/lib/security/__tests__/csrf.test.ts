import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateCsrf, isLocalRequest, isLoopbackHostname } from "@/lib/security/csrf";

function makeReq(over: RequestInit & { url?: string } = {}): Request {
  const { url = "http://127.0.0.1:2302/api/settings", ...init } = over;
  return new Request(url, init);
}

describe("validateCsrf", () => {
  afterEach(() => {
    delete process.env.APP_SECRET;
  });

  it("allows a same-origin browser mutation carrying Origin", () => {
    const res = validateCsrf(
      makeReq({
        method: "PUT",
        headers: {
          origin: "http://127.0.0.1:2302",
          "content-type": "application/json",
        },
      })
    );
    expect(res).toBeNull();
  });

  it("rejects a mutation with neither Origin nor Referer (drive-by)", () => {
    const res = validateCsrf(
      makeReq({
        method: "POST",
        headers: { "content-type": "application/json" },
      })
    );
    expect(res?.status).toBe(403);
  });

  it("rejects a mutation whose Origin points off-machine", () => {
    const res = validateCsrf(
      makeReq({
        method: "POST",
        headers: {
          origin: "http://evil.example.com",
          "content-type": "application/json",
        },
      })
    );
    expect(res?.status).toBe(403);
  });

  it("rejects a mutation with a non-JSON content-type", () => {
    const res = validateCsrf(
      makeReq({
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:2302",
          "content-type": "text/plain",
        },
      })
    );
    expect(res?.status).toBe(415);
  });

  it("allows non-bearer remote callers only with a valid Bearer secret", () => {
    process.env.APP_SECRET = "a".repeat(64);
    const ok = validateCsrf(
      makeReq({
        url: "http://10.0.0.5:2302/api/settings",
        method: "PUT",
        headers: {
          authorization: `Bearer ${"a".repeat(64)}`,
          "content-type": "application/json",
        },
      })
    );
    expect(ok).toBeNull();

    const bad = validateCsrf(
      makeReq({
        url: "http://10.0.0.5:2302/api/settings",
        method: "PUT",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      })
    );
    expect(bad?.status).toBe(401);
  });

  it("does not enforce CSRF on GET requests", () => {
    const res = validateCsrf(makeReq({ method: "GET", headers: {} }));
    expect(res).toBeNull();
  });
});

describe("isLocalRequest", () => {
  it("treats a spoofed off-machine x-forwarded-for as remote", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "10.0.0.9, 127.0.0.1" } });
    expect(isLocalRequest(req)).toBe(false);
  });

  it("treats loopback x-forwarded-for as local", () => {
    const req = makeReq({ headers: { "x-forwarded-for": "127.0.0.1" } });
    expect(isLocalRequest(req)).toBe(true);
  });
});

describe("isLoopbackHostname", () => {
  it("recognises bracketed ipv6 loopback", () => {
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });
});
