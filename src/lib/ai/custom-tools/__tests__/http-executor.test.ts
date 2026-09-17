import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeHttpCustomTool } from "../http-executor";
import { secureFetch } from "@/lib/security/ssrf";

vi.mock("@/lib/security/ssrf", () => ({
  secureFetch: vi.fn(),
}));

describe("executeHttpCustomTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("interpolates path variables and passes remaining parameters as query for GET", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "active" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/repos/{owner}/{repo}/status",
        method: "GET",
      },
      { owner: "alice", repo: "project", filter: "all" }
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ status: "active" });

    expect(secureFetch).toHaveBeenCalledWith(
      "https://api.test/repos/alice/project/status?filter=all",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "User-Agent": "yggdrasil-tool/0.1",
        }),
      })
    );
  });

  it("sends remaining parameters in JSON body for POST", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ created: true }), { status: 201 })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/items",
        method: "POST",
      },
      { name: "gadget", count: 42 }
    );

    expect(result.ok).toBe(true);
    expect(secureFetch).toHaveBeenCalledWith(
      "https://api.test/items",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "gadget", count: 42 }),
      })
    );
  });

  it("handles user cancellation when caller signal is already aborted", async () => {
    const callerController = new AbortController();
    callerController.abort();

    const cancelResult = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/cancelled",
        method: "GET",
      },
      {},
      callerController.signal
    );

    expect(cancelResult.ok).toBe(false);
    expect(cancelResult.error).toMatch(/cancelled by user/i);
    expect(secureFetch).not.toHaveBeenCalled();
  });

  it("handles user cancellation during active request", async () => {
    const callerController = new AbortController();

    vi.mocked(secureFetch).mockImplementationOnce(async (_url, opts) => {
      callerController.abort();
      const signal = opts?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const cancelResult = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/slow",
        method: "GET",
        timeoutMs: 5000,
      },
      {},
      callerController.signal
    );

    expect(cancelResult.ok).toBe(false);
    expect(cancelResult.error).toMatch(/cancelled by user/i);
  });

  it("handles timeout with differentiated error message", async () => {
    vi.useFakeTimers();
    vi.mocked(secureFetch).mockImplementationOnce(async (_url, opts) => {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const promise = executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/slow",
        method: "GET",
        timeoutMs: 1000,
      },
      {}
    );

    await vi.advanceTimersByTimeAsync(1000);
    const timeoutResult = await promise;
    vi.useRealTimers();

    expect(timeoutResult.ok).toBe(false);
    expect(timeoutResult.error).toMatch(/timed out after 1000ms/i);
  });

  it("safely truncates responses exceeding 50KB code-point safely", async () => {
    const longString = "A".repeat(60000);
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(longString, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/big",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(typeof result.data === "string" && (result.data as string).length).toBe(50000);
  });

  it("safely preserves surrogate pairs when truncating multi-byte unicode code points", async () => {
    // 25000 emojis (each 2 UTF-16 code units, 1 Unicode code point) + extra text
    const emojiString = "🦊".repeat(50005);
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(emojiString, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/unicode",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    // Array.from(data).length must be 50,000 code points
    const codePoints = Array.from(result.data as string);
    expect(codePoints.length).toBe(50000);
    expect(codePoints.every((cp) => cp === "🦊")).toBe(true);
  });

  it("caps non-2xx error responses at 4KB", async () => {
    const longError = "Error: " + "X".repeat(10000);
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(longError, {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/fail",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(typeof result.error === "string" && (result.error as string).length).toBeLessThanOrEqual(4096 + 100);
    expect(result.error).toContain("HTTP 500 Internal Server Error:");
  });

  it("handles DELETE with query parameters", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/items/{id}",
        method: "DELETE",
      },
      { id: "123", force: true }
    );

    expect(result.ok).toBe(true);
    expect(secureFetch).toHaveBeenCalledWith(
      "https://api.test/items/123?force=true",
      expect.objectContaining({
        method: "DELETE",
      })
    );
  });

  it("handles non-JSON text responses gracefully", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response("plain response text", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/text",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(true);
    expect(result.data).toBe("plain response text");
  });

  it("falls back to raw text if content-type is json but JSON.parse throws", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response("malformed json {", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/malformed",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(true);
    expect(result.data).toBe("malformed json {");
  });

  it("defensively clamps timeoutMs to [1000, 30000]", async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    // timeoutMs too low -> clamped to 1000
    await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/clamp-low",
        method: "GET",
        timeoutMs: 100,
      },
      {}
    );
    expect(secureFetch).toHaveBeenCalledWith(
      "https://api.test/clamp-low",
      expect.objectContaining({ timeoutMs: 1000 })
    );

    // timeoutMs too high -> clamped to 30000
    await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/clamp-high",
        method: "GET",
        timeoutMs: 60000,
      },
      {}
    );
    expect(secureFetch).toHaveBeenCalledWith(
      "https://api.test/clamp-high",
      expect.objectContaining({ timeoutMs: 30000 })
    );
  });

  it("handles unexpected network error gracefully", async () => {
    vi.mocked(secureFetch).mockRejectedValueOnce(new Error("Connection refused"));

    const result = await executeHttpCustomTool(
      {
        type: "http",
        url: "https://api.test/error",
        method: "GET",
      },
      {}
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Network execution error: Connection refused");
  });
});
