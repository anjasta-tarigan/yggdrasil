import { describe, it, expect } from "vitest";
import { parseSessionCandidate, classifyFailure } from "../adapter";

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

  it("rejects tokens with newlines, control characters, or exceeding 8192 chars", () => {
    expect(parseSessionCandidate({ userToken: "abc\ndef" }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "abc\rdef" }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "a".repeat(8193) }).ok).toBe(false);
    expect(parseSessionCandidate({ userToken: "" }).ok).toBe(false);
  });

  it("classifies upstream failures into safe typed codes without raw text", () => {
    const authErr = classifyFailure(new Response("raw internal token echo", { status: 401 }));
    expect(authErr.code).toBe("session_rejected");
    expect(authErr.message).toBe("The session was rejected. Your credentials were not saved.");
    expect(authErr.message).not.toContain("raw internal token echo");

    const rateErr = classifyFailure(new Response("", { status: 429 }));
    expect(rateErr.code).toBe("rate_limited");

    const protoErr = classifyFailure(new Response("", { status: 502 }));
    expect(protoErr.code).toBe("protocol_error");
  });
});
