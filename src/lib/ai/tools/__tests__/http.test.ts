import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { http_request } = await import("../http");

// SSRF validation is not under test here; route every URL straight through.
vi.mock("@/lib/security/ssrf", () => ({
  assertSafeUrl: vi.fn(async () => {}),
  secureFetch: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
  SSRFError: class SSRFError extends Error {},
}));

type HttpOutput = {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
  error?: string;
};

const callHttp = (input: Record<string, unknown>) =>
  (
    http_request as unknown as {
      execute: (i: unknown, opts: unknown) => Promise<HttpOutput>;
    }
  ).execute(input, {});

describe("http_request tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("performs a GET and frames the response body as untrusted data", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("hello world", {
          status: 200,
          headers: { "Content-Type": "text/plain", "X-Custom": "v1" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await callHttp({ url: "https://example.com/data", method: "GET" });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.contentType).toContain("text/plain");
    expect(res.headers?.["x-custom"]).toBe("v1");
    // The body is wrapped so the model treats it as data, never instructions.
    expect(res.body).toContain("<untrusted_http_response>");
    expect(res.body).toContain("hello world");
  });

  it("sends a POST with a JSON body and parses JSON responses", async () => {
    let captured: { method?: string; body?: unknown; headers?: Record<string, string> } = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = {
        method: init?.method,
        body: init?.body,
        headers: init?.headers as Record<string, string>,
      };
      return new Response(JSON.stringify({ id: 1, ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callHttp({
      url: "https://api.example.com/items",
      method: "POST",
      body: '{"name":"widget"}',
      headers: { "Content-Type": "application/json" },
    });

    expect(captured.method).toBe("POST");
    expect(captured.body).toBe('{"name":"widget"}');
    expect(captured.headers?.["Content-Type"]).toBe("application/json");
    expect(res.status).toBe(201);
    expect(res.body).toContain('"id":1');
  });

  it("truncates a response body beyond maxBytes and reports it", async () => {
    const big = "x".repeat(5_000);
    const fetchMock = vi.fn(
      async () => new Response(big, { status: 200, headers: { "Content-Type": "text/plain" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await callHttp({ url: "https://example.com/big", maxBytes: 1_000 });

    expect(res.truncated).toBe(true);
    expect(res.body!.length).toBeLessThan(big.length + 500);
  });

  it("returns a structured error instead of throwing on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );

    const res = await callHttp({ url: "https://example.com/x" });
    expect(res.error).toMatch(/network down|failed/i);
  });
});
