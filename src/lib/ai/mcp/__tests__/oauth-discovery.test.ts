import { describe, it, expect } from "vitest";
import {
  authorizationServerMetadataUrls,
  discoverOAuth,
  OAuthDiscoveryError,
  resourceMetadataUrls,
  type FetchJsonResult,
} from "../oauth-discovery";

function json(data: Record<string, unknown>, status = 200): FetchJsonResult {
  return { ok: true, status, data };
}

const notFound: FetchJsonResult = { ok: false, status: 404, data: null };

const serverMetadata = {
  authorization_endpoint: "https://auth.example/authorize",
  token_endpoint: "https://auth.example/token",
  registration_endpoint: "https://auth.example/register",
  scopes_supported: ["mcp", "read"],
};

describe("well-known URL candidates", () => {
  it("tries the path-suffixed then root protected resource metadata", () => {
    expect(resourceMetadataUrls(new URL("https://mcp.example/api/mcp"))).toEqual([
      "https://mcp.example/.well-known/oauth-protected-resource/api/mcp",
      "https://mcp.example/.well-known/oauth-protected-resource",
    ]);
  });

  it("tries RFC 8414 shapes before OIDC discovery", () => {
    expect(authorizationServerMetadataUrls(new URL("https://auth.example/tenant"))).toEqual([
      "https://auth.example/.well-known/oauth-authorization-server/tenant",
      "https://auth.example/.well-known/oauth-authorization-server",
      "https://auth.example/tenant/.well-known/openid-configuration",
      "https://auth.example/.well-known/openid-configuration",
    ]);
  });
});

describe("discoverOAuth", () => {
  it("discovers authorization server metadata declared by the resource", async () => {
    const seen: string[] = [];
    const result = await discoverOAuth("https://mcp.example/mcp", {
      fetchJson: async (url) => {
        seen.push(url);
        if (url.includes("oauth-protected-resource")) {
          return json({ authorization_servers: ["https://auth.example"] });
        }
        if (url === "https://auth.example/.well-known/oauth-authorization-server") {
          return json(serverMetadata);
        }
        return notFound;
      },
    });

    expect(result.metadata.tokenEndpoint).toBe("https://auth.example/token");
    expect(result.issuer).toBe("https://auth.example/");
    expect(result.resourceMetadataUrl).toBe(
      "https://mcp.example/.well-known/oauth-protected-resource/mcp"
    );
    // Path-suffixed RFC 8414 candidate is attempted first.
    expect(seen).toContain("https://auth.example/.well-known/oauth-authorization-server");
  });

  it("falls back to the root protected resource metadata", async () => {
    const result = await discoverOAuth("https://mcp.example/mcp", {
      fetchJson: async (url) => {
        if (url === "https://mcp.example/.well-known/oauth-protected-resource") {
          return json({ authorization_servers: ["https://auth.example"] });
        }
        if (url === "https://auth.example/.well-known/oauth-authorization-server") {
          return json(serverMetadata);
        }
        return notFound;
      },
    });
    expect(result.resourceMetadataUrl).toBe(
      "https://mcp.example/.well-known/oauth-protected-resource"
    );
  });

  it("falls back to OIDC discovery metadata", async () => {
    const result = await discoverOAuth("https://mcp.example/mcp", {
      fetchJson: async (url) => {
        if (url.endsWith("oauth-protected-resource/mcp") || url.endsWith("oauth-protected-resource")) {
          return json({ authorization_servers: ["https://auth.example"] });
        }
        if (url === "https://auth.example/.well-known/openid-configuration") {
          return json(serverMetadata);
        }
        return notFound;
      },
    });
    expect(result.authorizationServerMetadataUrl).toBe(
      "https://auth.example/.well-known/openid-configuration"
    );
  });

  it("uses the resource origin when authorization_servers is omitted", async () => {
    const result = await discoverOAuth("https://mcp.example/mcp", {
      fetchJson: async (url) => {
        if (url.endsWith("mcp.example/.well-known/oauth-protected-resource/mcp")) {
          return json({});
        }
        if (url === "https://mcp.example/.well-known/oauth-authorization-server") {
          return json(serverMetadata);
        }
        return notFound;
      },
    });
    expect(result.issuer).toBe("https://mcp.example/");
  });

  it("falls back to authorization-server metadata when protected resource metadata is absent", async () => {
    const result = await discoverOAuth("https://mcp.example/mcp", {
      fetchJson: async (url) => {
        if (url.includes("oauth-protected-resource")) return notFound;
        if (url === "https://mcp.example/.well-known/oauth-authorization-server") {
          return json(serverMetadata);
        }
        return notFound;
      },
    });
    expect(result.resourceMetadataUrl).toBe("");
    expect(result.authorizationServerMetadataUrl).toBe(
      "https://mcp.example/.well-known/oauth-authorization-server"
    );
  });

  it("raises a resource_metadata error when protected resource metadata is missing", async () => {
    await expect(
      discoverOAuth("https://mcp.example/mcp", { fetchJson: async () => notFound })
    ).rejects.toMatchObject({ name: "OAuthDiscoveryError", stage: "resource_metadata" });
  });

  it("raises an authorization_server_metadata error when metadata is unusable", async () => {
    await expect(
      discoverOAuth("https://mcp.example/mcp", {
        fetchJson: async (url) => {
          if (url.includes("oauth-protected-resource")) {
            return json({ authorization_servers: ["https://auth.example"] });
          }
          if (url.includes("authorization-server") || url.includes("openid-configuration")) {
            return json({ authorization_endpoint: "https://auth.example/authorize" });
          }
          return notFound;
        },
      })
    ).rejects.toBeInstanceOf(OAuthDiscoveryError);
  });
});
