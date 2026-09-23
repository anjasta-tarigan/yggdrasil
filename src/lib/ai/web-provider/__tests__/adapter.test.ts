import { describe, it, expect } from "vitest";
import { parseSessionCandidate, classifyFailure, ERROR_MAPPING } from "../adapter";

describe("WebProviderAdapter Contract & Parsing", () => {
  it("parses raw userToken and strips literal case-sensitive prefix", () => {
    // Exact prefix userToken= stripped
    const res1 = parseSessionCandidate({ userToken: "userToken=sk-abc123456==" });
    expect(res1.ok).toBe(true);
    if (res1.ok) expect(res1.data.userToken).toBe("sk-abc123456==");

    // Raw token preserved (including trailing base64 equals)
    const res2 = parseSessionCandidate({ userToken: "sk-xyz789012==" });
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.data.userToken).toBe("sk-xyz789012==");
  });

  it("does not strip the prefix when its casing differs", () => {
    // Prefix stripping is case-sensitive; USERTOKEN= is not a match and stays intact
    const res = parseSessionCandidate({ userToken: "USERTOKEN=abc" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.userToken).toBe("USERTOKEN=abc");
  });

  it("rejects tokens with newlines, control characters, or exceeding 8192 chars", () => {
    expect(parseSessionCandidate({ userToken: "abc\ndef" }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "abc\rdef" }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "abc\x00def" }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "a".repeat(8193) }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "" }).ok).toBe(false);
  });

  it("accepts a token exactly at the 8192-char boundary", () => {
    const atBoundary = parseSessionCandidate({ userToken: "a".repeat(8192) });
    expect(atBoundary.ok).toBe(true);
    if (atBoundary.ok) expect(atBoundary.data.userToken).toHaveLength(8192);
  });

  it("classifies every upstream status into its closed typed code and mapped httpStatus", () => {
    const cases: Array<{ label: string; response: Response; code: string; httpStatus: number }> = [
      { label: "401", response: new Response("raw-401", { status: 401 }), code: "session_rejected", httpStatus: 401 },
      { label: "403", response: new Response("raw-403", { status: 403 }), code: "session_rejected", httpStatus: 401 },
      { label: "429", response: new Response("raw-429", { status: 429 }), code: "rate_limited", httpStatus: 429 },
      // Redirects surface as an unsupported protocol, normalized to a 502 gateway status — not the raw 302
      { label: "302", response: new Response("raw-302", { status: 302 }), code: "unsupported_protocol", httpStatus: 502 },
      { label: "408", response: new Response("raw-408", { status: 408 }), code: "upstream_timeout", httpStatus: 504 },
      { label: "504", response: new Response("raw-504", { status: 504 }), code: "upstream_timeout", httpStatus: 504 },
      { label: "502", response: new Response("raw-502", { status: 502 }), code: "protocol_error", httpStatus: 502 },
    ];

    for (const { label, response, code, httpStatus } of cases) {
      const failure = classifyFailure(response);
      expect(failure.code, `status ${label}`).toBe(code);
      expect(failure.httpStatus, `status ${label}`).toBe(httpStatus);
    }
  });

  it("maps thrown errors to network_error and aborts to upstream_timeout", () => {
    const networkErr = classifyFailure(new Error("raw-network-failure"));
    expect(networkErr.code).toBe("network_error");
    expect(networkErr.httpStatus).toBe(502);

    // Abort detection keys off the Error name first, then the message
    const namedAbort = new Error("request cancelled");
    namedAbort.name = "AbortError";
    expect(classifyFailure(namedAbort).code).toBe("upstream_timeout");
    expect(classifyFailure(namedAbort).httpStatus).toBe(504);

    expect(classifyFailure(new Error("the request was aborted")).code).toBe("upstream_timeout");
  });

  it("maps non-Response, non-Error inputs to protocol_error", () => {
    for (const input of [null, undefined, "string", 42, {}]) {
      const failure = classifyFailure(input);
      expect(failure.code).toBe("protocol_error");
      expect(failure.httpStatus).toBe(502);
    }
  });

  it("never echoes raw upstream text in any classified message", () => {
    const rawText = "raw internal token echo";
    const abortError = new Error(rawText);
    abortError.name = "AbortError";
    const failures = [
      classifyFailure(new Response(rawText, { status: 401 })),
      classifyFailure(new Response(rawText, { status: 403 })),
      classifyFailure(new Response(rawText, { status: 429 })),
      classifyFailure(new Response(rawText, { status: 302 })),
      classifyFailure(new Response(rawText, { status: 504 })),
      classifyFailure(new Response(rawText, { status: 502 })),
      classifyFailure(new Error(rawText)),
      classifyFailure(abortError),
      classifyFailure(rawText),
    ];

    for (const failure of failures) {
      expect(failure.message).not.toContain(rawText);
      // Messages come from the closed mapping only, never from upstream payloads
      expect(failure.message).toBe(ERROR_MAPPING[failure.code].message);
    }

    // Sanity check the canonical session_rejected copy the UI relies on
    expect(classifyFailure(new Response(rawText, { status: 401 })).message).toBe(
      "The session was rejected. Your credentials were not saved."
    );
  });
});
