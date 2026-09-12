import { describe, it, expect, beforeEach, vi } from "vitest";

// Import the module ONCE before any key is set, so the module-level
// `const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY` (if any remains)
// captures an empty environment. The bug being tested: web_fetch must read
// the key at CALL time, not at import time.
const webTools = await import("../web");
const { web_fetch } = webTools;

// SSRF validation is not under test here; route every URL straight through.
vi.mock("@/lib/security/ssrf", () => ({
  assertSafeUrl: vi.fn(async () => {}),
}));

const callWebFetch = (url: string) =>
  // The tool object's execute is typed via a strict ToolSet; cast to the
  // loose call shape the SDK actually invokes at runtime.
  (web_fetch as unknown as {
    execute: (input: { url: string; maxCharacters?: number }, opts: unknown) => Promise<unknown>;
  }).execute({ url, maxCharacters: 500 }, {});

describe("web_fetch FIRECRAWL_API_KEY freshness", () => {
  const originalKey = process.env.FIRECRAWL_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    if (originalKey === undefined) {
      delete process.env.FIRECRAWL_API_KEY;
    } else {
      process.env.FIRECRAWL_API_KEY = originalKey;
    }
  });

  it("uses a FIRECRAWL_API_KEY set after module load (call-time read)", async () => {
    // Key absent at import time (see module-level import above), present now.
    process.env.FIRECRAWL_API_KEY = "late-set-key";

    let capturedAuth: string | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
        return new Response(
          JSON.stringify({
            success: true,
            data: { markdown: "# fresh", metadata: { title: "Fresh" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error("native fetch should not be reached when Firecrawl succeeds");
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = (await callWebFetch("https://example.com/page")) as {
      markdown: string;
    };

    expect(capturedAuth).toBe("Bearer late-set-key");
    expect(result.markdown).toBe("# fresh");
  });

  it("falls back to native fetch when the key is absent at call time", async () => {
    delete process.env.FIRECRAWL_API_KEY;

    let firecrawlCalled = false;
    let nativeCalled = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        firecrawlCalled = true;
      } else {
        nativeCalled = true;
      }
      if (url.includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ success: false, error: "quota" }), {
          status: 402,
        });
      }
      return new Response(
        "<html><head><title>Native OK</title></head><body><p>hello</p></body></html>",
        { status: 200, headers: { "Content-Type": "text/html" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = (await callWebFetch("https://example.com/other")) as {
      markdown: string;
    };

    expect(firecrawlCalled).toBe(false);
    expect(nativeCalled).toBe(true);
    expect(result.markdown).toContain("hello");
  });
});
