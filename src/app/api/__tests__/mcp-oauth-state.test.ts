import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeOAuthState, encodeOAuthState } from "@/lib/ai/mcp/oauth-flow";

vi.stubEnv("APP_SECRET", "oauth-state-test-secret-with-enough-entropy");

function sign(payload: Record<string, unknown>) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", process.env.APP_SECRET!).update(body).digest("base64url");
  return `${body}.${signature}`;
}

describe("MCP OAuth state", () => {
  it("accepts signed state issued within the last ten minutes", () => {
    expect(decodeOAuthState(sign({ issuedAt: Date.now(), stateId: "test-nonce", serverId: "mcp-test" }))).toMatchObject({ serverId: "mcp-test" });
  });

  it("rejects expired, unsigned, and malformed state", () => {
    expect(decodeOAuthState(sign({ issuedAt: Date.now() - 10 * 60_000 - 1, stateId: "old", serverId: "mcp-test" }))).toBeNull();
    expect(decodeOAuthState("not.signed")).toBeNull();
    expect(decodeOAuthState("bad")).toBeNull();
  });

  it("rejects state with a tampered signature", () => {
    const [body] = sign({ issuedAt: Date.now(), stateId: "nonce", serverId: "mcp-test" }).split(".");
    expect(decodeOAuthState(`${body}.tampered`)).toBeNull();
  });

  it("round-trips state issued by the start route", () => {
    const token = encodeOAuthState({
      issuedAt: Date.now(),
      stateId: "nonce",
      serverId: "mcp-test",
      serverName: "Test Server",
    });
    expect(decodeOAuthState(token)).toMatchObject({
      stateId: "nonce",
      serverId: "mcp-test",
      serverName: "Test Server",
    });
  });

  it("rejects signed state missing required fields", () => {
    expect(decodeOAuthState(sign({ issuedAt: Date.now(), stateId: "nonce" }))).toBeNull();
  });
});
