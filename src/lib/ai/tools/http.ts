import { tool } from "ai";
import { z } from "zod";
import { secureFetch, assertSafeUrl, SSRFError } from "@/lib/security/ssrf";
import { wrapUntrustedContent } from "@/lib/ai/untrusted-content";

/**
 * Generic outbound HTTP client (the `curl` equivalent for the agent).
 *
 * `web_fetch` is markdown-oriented: it scrapes a page and converts it to
 * readable text. This tool is the general-purpose counterpart — it performs a
 * request against any HTTP(S) endpoint with a chosen method, headers and body,
 * and returns the raw response (status, headers, body). Use it for JSON/REST
 * APIs, webhooks, form submissions, and anything where the raw protocol
 * matters rather than the rendered page.
 *
 * Security: all outbound traffic goes through `secureFetch`, so SSRF defense
 * (protocol allowlist, DNS re-resolution, private/loopback/metadata IP blocks,
 * redirect re-validation) applies identically to `web_fetch`. The response
 * body is attacker-controlled and is wrapped as labelled untrusted data.
 */

/** Hard ceiling on the returned body, independent of the caller's request. */
const MAX_BODY_BYTES_CAP = 1 * 1024 * 1024; // 1 MB
const DEFAULT_MAX_BODY_BYTES = 256 * 1024; // 256 KB
/** Request timeout ceiling. */
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
/** Request body ceiling — a tool call is not a file upload channel. */
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export const http_request = tool({
  description:
    "Make an arbitrary HTTP(S) request and return the raw response — the general-purpose counterpart to web_fetch (which is markdown/page oriented). Use for REST/JSON APIs, webhooks, or any endpoint where you need a specific method, headers, or request body. Returns status, response headers, and the response body. All requests are SSRF-guarded (private/loopback/metadata addresses are blocked) and the response body is returned as untrusted data.",
  inputSchema: z.object({
    url: z.string().url().describe("Absolute http(s) URL to request"),
    method: z
      .enum(HTTP_METHODS)
      .default("GET")
      .describe("HTTP method (default GET)"),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Request headers, e.g. { \"Authorization\": \"Bearer …\", \"Content-Type\": \"application/json\" }"),
    body: z
      .string()
      .max(MAX_REQUEST_BODY_BYTES)
      .optional()
      .describe("Request body (for POST/PUT/PATCH). Pass a JSON string when sending JSON."),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_TIMEOUT_MS)
      .default(DEFAULT_TIMEOUT_MS)
      .describe(`Request timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`),
    maxBytes: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_BODY_BYTES_CAP)
      .default(DEFAULT_MAX_BODY_BYTES)
      .describe(
        `Maximum response body bytes to return (default ${DEFAULT_MAX_BODY_BYTES}, capped at ${MAX_BODY_BYTES_CAP})`
      ),
    followRedirects: z
      .boolean()
      .default(true)
      .describe("Follow up to 5 HTTP redirects (each hop is re-validated against SSRF rules)"),
  }),
  execute: async ({ url, method, headers, body, timeoutMs, maxBytes, followRedirects }) => {
    try {
      await assertSafeUrl(url);

      const res = await secureFetch(url, {
        method,
        headers,
        ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}),
        timeoutMs,
        maxBytes: Math.min(MAX_BODY_BYTES_CAP, maxBytes),
        maxRedirects: followRedirects ? 5 : 0,
      });

      const raw = await res.text();
      const truncated = Buffer.byteLength(raw, "utf8") > maxBytes;
      const text = truncated
        ? Buffer.from(raw, "utf8").subarray(0, maxBytes).toString("utf8")
        : raw;

      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type"),
        headers: responseHeaders,
        truncated,
        // The body is attacker-controlled: wrap it as data, never instructions.
        body: wrapUntrustedContent({
          tag: "untrusted_http_response",
          provenance: `HTTP ${res.status} response from ${url}`,
          content: text,
        }),
      };
    } catch (err) {
      // Expected runtime conditions (network, SSRF block, timeout) are
      // returned as structured output so the model can see and recover.
      const message =
        err instanceof SSRFError || err instanceof Error
          ? err.message
          : String(err);
      return { ok: false, error: message };
    }
  },
});
