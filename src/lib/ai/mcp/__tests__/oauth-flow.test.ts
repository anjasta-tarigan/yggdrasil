import { describe, it, expect, vi } from "vitest";
import {
  OAUTH_FLOW_TTL_MS,
  oauthErrorCookieName,
  oauthFlowCookieName,
  openOAuthFlow,
  sealOAuthFlow,
  type PendingOAuthFlow,
} from "../oauth-flow";

vi.stubEnv("APP_SECRET", "oauth-flow-test-secret-with-enough-entropy");

function flow(overrides: Partial<PendingOAuthFlow> = {}): PendingOAuthFlow {
  return {
    stateId: "state-1",
    serverId: "mcp-test",
    serverName: "Test Server",
    clientId: "client-1",
    clientSecret: "secret-1",
    redirectUri: "https://app.example/api/mcp/auth/callback",
    tokenEndpoint: "https://auth.example/token",
    resource: "https://mcp.example/mcp",
    scopes: ["mcp"],
    codeVerifier: "verifier-1",
    issuedAt: Date.now(),
    ...overrides,
  };
}

describe("sealed OAuth flow cookie", () => {
  it("round-trips a flow", () => {
    const value = flow();
    expect(openOAuthFlow(sealOAuthFlow(value))).toEqual(value);
  });

  it("keeps an optional client secret undefined when absent", () => {
    const value = flow();
    delete value.clientSecret;
    expect(openOAuthFlow(sealOAuthFlow(value))?.clientSecret).toBeUndefined();
  });

  it("rejects expired flows", () => {
    const sealed = sealOAuthFlow(flow({ issuedAt: Date.now() - OAUTH_FLOW_TTL_MS - 1 }));
    expect(openOAuthFlow(sealed)).toBeNull();
  });

  it("rejects tampered or missing values", () => {
    const sealed = sealOAuthFlow(flow());
    expect(openOAuthFlow(sealed.slice(0, -4) + "AAAA")).toBeNull();
    expect(openOAuthFlow("not-a-sealed-flow")).toBeNull();
    expect(openOAuthFlow(null)).toBeNull();
    expect(openOAuthFlow("")).toBeNull();
  });

  it("rejects structurally invalid payloads", () => {
    const sealed = sealOAuthFlow(flow({ tokenEndpoint: "" }));
    expect(openOAuthFlow(sealed)).toBeNull();
  });

  it("names cookies per flow and derives a safe error-cookie name", () => {
    expect(oauthFlowCookieName("abc")).toBe("mcp_oauth_flow_abc");
    const errorCookie = oauthErrorCookieName("mcp-test");
    expect(errorCookie).toMatch(/^mcp_oauth_error_[a-f0-9]{16}$/);
    expect(errorCookie).toBe(oauthErrorCookieName("mcp-test"));
    expect(oauthErrorCookieName("other")).not.toBe(errorCookie);
  });
});
