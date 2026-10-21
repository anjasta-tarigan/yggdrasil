import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { consumeOAuthState, decodeState, registerOAuthState } from "../mcp/auth/start/route";

vi.stubEnv("APP_SECRET", "oauth-state-test-secret-with-enough-entropy");

function sign(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", process.env.APP_SECRET!).update(body).digest("base64url");
  return `${body}.${signature}`;
}

describe("MCP OAuth state", () => {
  it("accepts signed state issued within the last ten minutes", () => {
    expect(decodeState(sign({ issuedAt: Date.now(), stateId: "test-nonce", serverId: "mcp-test" }))).toMatchObject({ serverId: "mcp-test" });
  });

  it("rejects expired, unsigned, and malformed state", () => {
    expect(decodeState(sign({ issuedAt: Date.now() - 10 * 60_000 - 1, stateId: "old", serverId: "mcp-test" }))).toBeNull();
    expect(decodeState("not.signed")).toBeNull();
    expect(decodeState("bad")).toBeNull();
  });

  it("consumes valid OAuth state exactly once", () => {
    registerOAuthState("one-time", Date.now() + 60_000);
    expect(consumeOAuthState("one-time")).toBe(true);
    expect(consumeOAuthState("one-time")).toBe(false);
  });
});
