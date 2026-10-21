import { NextResponse } from "next/server";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";
import { getMcpServerConfigs, updateMcpServer } from "@/lib/ai/mcp/manager";
import type { McpServerConfig } from "@/lib/ai/mcp/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const serverId = new URL(req.url).searchParams.get("serverId");
  const config = getMcpServerConfigs().find((server) => server.id === serverId);
  if (!config) return NextResponse.json({ error: "Unknown MCP server" }, { status: 404 });
  if (!config.url || (config.transport !== "http" && config.transport !== "sse")) {
    return NextResponse.json({ oauth: false, apiKey: true });
  }

  try {
    const resource = new URL(config.url);
    const metadataUrl = new URL(`/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`, resource.origin).toString();
    await assertSafeUrl(metadataUrl);
    const response = await secureFetch(metadataUrl, { timeoutMs: 10_000, headers: { Accept: "application/json" } });
    if (!response.ok) return response.status === 404
      ? NextResponse.json({ oauth: false, apiKey: true })
      : NextResponse.json({ error: `OAuth resource metadata returned ${response.status}` }, { status: 502 });
    const metadata = await response.json() as { authorization_servers?: unknown };
    const issuer = Array.isArray(metadata.authorization_servers)
      ? metadata.authorization_servers.find((value): value is string => typeof value === "string")
      : undefined;
    if (!issuer) return NextResponse.json({ oauth: false, apiKey: true });
    const issuerUrl = new URL(issuer);
    const authUrl = new URL(`/.well-known/oauth-authorization-server${issuerUrl.pathname === "/" ? "" : issuerUrl.pathname}`, issuerUrl.origin).toString();
    await assertSafeUrl(authUrl);
    const authResponse = await secureFetch(authUrl, { timeoutMs: 10_000, headers: { Accept: "application/json" } });
    if (!authResponse.ok) return authResponse.status === 404
      ? NextResponse.json({ oauth: false, apiKey: true })
      : NextResponse.json({ error: `OAuth server metadata returned ${authResponse.status}` }, { status: 502 });
    const authMetadata = await authResponse.json() as { authorization_endpoint?: unknown; token_endpoint?: unknown; scopes_supported?: unknown };
    if (typeof authMetadata.authorization_endpoint !== "string" || typeof authMetadata.token_endpoint !== "string") {
      return NextResponse.json({ oauth: false, apiKey: true });
    }
    await assertSafeUrl(authMetadata.authorization_endpoint);
    await assertSafeUrl(authMetadata.token_endpoint);
    return NextResponse.json({ oauth: true, authUrl, scopes: Array.isArray(authMetadata.scopes_supported) ? authMetadata.scopes_supported.filter((scope): scope is string => typeof scope === "string") : [] , apiKey: true });
  } catch (error) {
    console.warn("[api/mcp/auth] OAuth capability discovery failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Could not determine whether this server supports OAuth" }, { status: 502 });
  }
}

/**
 * MCP authentication management for the Settings UI.
 *
 * POST { serverId, method }        — start an auth flow (returns authUrl for OAuth, or ok for API key).
 * POST { serverId, code }           — complete an OAuth flow with the returned code.
 * POST { serverId, apiKey }         — complete an API key flow.
 * DELETE { serverId }             — clear auth state (returns "not_configured").
 */

interface AuthRequest {
  serverId?: string;
  method?: "oauth" | "api_key" | "none";
  code?: string;
  redirectUri?: string;
  apiKey?: string;
  apiKeyName?: string;
}

/**
 * Resolve a server's auth provider metadata from its connection details.
 * Returns the auth configuration if the server declares one.
 */
function getAuthInfo(config: McpServerConfig): { type?: "oauth" | "api_key"; url?: string; clientId?: string; scopes?: string[] } | null {
  if (!config.url) return null;
  try {
    const u = new URL(config.url);
    // OAuth discovery is at /.well-known/oauth-authorization-server/{path}
    const wellKnownUrl = `${u.origin}${u.pathname.replace(/\/$/, "") || ""}/.well-known/oauth-authorization-server`;
    return { type: "oauth", url: wellKnownUrl };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  let body: AuthRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { serverId, method, code, redirectUri, apiKey, apiKeyName } = body;

  if (typeof serverId !== "string" || !serverId) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const servers = getMcpServerConfigs();
  const config = servers.find((s) => s.id === serverId);
  if (!config) {
    return NextResponse.json({ error: `Unknown MCP server id "${serverId}"` }, { status: 404 });
  }

  if ((body as { method?: string }).method === "oauth" || code) {
    return NextResponse.json({ error: "Use the signed OAuth start and callback flow" }, { status: 410 });
  }

  // --- Start auth flow ---
  if (method && !code && !apiKey) {
    if (method === "oauth") {
      const authInfo = getAuthInfo(config);
      if (!authInfo || !authInfo.url) {
        return NextResponse.json(
          { error: "Server does not declare an OAuth provider" },
          { status: 400 }
        );
      }

      try {
        // Fetch the OAuth metadata from the server (SSRF-safe).
        await assertSafeUrl(authInfo.url);
        const res = await secureFetch(authInfo.url, {
          timeoutMs: 10_000,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          return NextResponse.json(
            { error: `OAuth discovery failed: ${res.status}` },
            { status: 502 }
          );
        }
        const metadata = await res.json() as {
          authorization_endpoint?: string;
          token_endpoint?: string;
          registration_endpoint?: string;
          scopes_supported?: string[];
        };

        // Derive client credentials. If the server provides a
        // registration_endpoint, we can dynamically register.
        const clientId = `yggdrasil-${config.id.slice(0, 8)}`;
        const scopes = metadata.scopes_supported ?? ["mcp"];
        const redirect = redirectUri ?? `https://${new URL(req.url).host}/api/mcp/auth/callback`;

        const authUrl = new URL(metadata.authorization_endpoint ?? `${authInfo.url}/authorize`);
        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirect);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", scopes.join(" "));
        authUrl.searchParams.set("state", Buffer.from(`${config.id}:${Date.now()}`).toString("base64url"));

        // Store auth metadata on the config so the callback can use it.
        updateMcpServer(config.id, {
          auth: {
            method: "oauth",
            status: "not_configured",
            oauthScopes: scopes,
          },
        });

        return NextResponse.json({
          ok: true,
          authUrl: authUrl.toString(),
          needsCallback: true,
        });
      } catch (err) {
        console.warn(`[api/mcp/auth] OAuth discovery failed for "${config.name}":`, err);
        return NextResponse.json(
          { error: "Failed to discover OAuth configuration" },
          { status: 502 }
        );
      }
    }

    if (method === "api_key") {
      // Just mark auth method; the API key is provided in a separate step.
      updateMcpServer(config.id, {
        auth: {
          method: "api_key",
          status: "not_configured",
        },
      });
      return NextResponse.json({ ok: true, needsApiKey: true });
    }

    if (method === "none") {
      updateMcpServer(config.id, {
        auth: {
          method: "none",
          status: "configured",
        },
      });
      return NextResponse.json({ ok: true, needsApiKey: false });
    }

    return NextResponse.json({ error: "Unknown auth method" }, { status: 400 });
  }

  // --- Complete OAuth flow ---
  if (code && method) {
    // Exchange the code for a token at the server's token endpoint.
    // The token is stored via the secret store (writeMcpSecret).
    if (!config.auth || config.auth.status !== "not_configured") {
      return NextResponse.json(
        { error: "Server auth is not in a startable state" },
        { status: 400 }
      );
    }

    try {
      // The token endpoint is already known from the start flow's state
      // token; re-derive discovery URL from config.url as a fallback.
      const authInfo = getAuthInfo(config);
      if (!authInfo?.url) {
        return NextResponse.json({ error: "Server has no auth URL" }, { status: 400 });
      }
      const discoveryUrl = authInfo.url;
      await assertSafeUrl(discoveryUrl);
      const res = await secureFetch(discoveryUrl, {
        timeoutMs: 10_000,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        return NextResponse.json(
          { error: `OAuth discovery failed: ${res.status}` },
          { status: 502 }
        );
      }
      const metadata = await res.json() as {
        token_endpoint?: string;
      };

      const tokenUrl = metadata.token_endpoint;
      if (!tokenUrl) {
        return NextResponse.json(
          { error: "OAuth provider has no token endpoint" },
          { status: 502 }
        );
      }

      await assertSafeUrl(tokenUrl);
      const tokenRes = await secureFetch(tokenUrl, {
        method: "POST",
        timeoutMs: 10_000,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri ?? "",
          client_id: `yggdrasil-${config.id.slice(0, 8)}`,
        }).toString(),
      });

      if (!tokenRes.ok) {
        return NextResponse.json(
          { error: `Token exchange failed: ${tokenRes.status}` },
          { status: 502 }
        );
      }

      const tokenData = await tokenRes.json() as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      // Store tokens as secrets keyed by server id.
      const { writeMcpSecret } = await import("@/lib/ai/mcp/secrets");
      await writeMcpSecret(`mcp_${config.id}_access_token`, tokenData.access_token);
      if (tokenData.refresh_token) {
        await writeMcpSecret(`mcp_${config.id}_refresh_token`, tokenData.refresh_token);
      }

      const now = Date.now();
      updateMcpServer(config.id, {
        auth: {
          method: "oauth",
          status: "configured",
          lastAuthenticatedAt: now,
          oauthScopes: config.auth?.oauthScopes,
        },
      });

      return NextResponse.json({ ok: true, authStatus: "configured" });
    } catch (err) {
      console.error(`[api/mcp/auth] OAuth token exchange failed for "${config.name}":`, err);
      return NextResponse.json(
        { error: "Failed to exchange OAuth code for token" },
        { status: 502 }
      );
    }
  }

  // --- Complete API key auth ---
  if (apiKey && typeof apiKey === "string") {
    const validKeyName = typeof apiKeyName === "string" && (
      config.transport === "stdio"
        ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(apiKeyName)
        : /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(apiKeyName)
    );
    if (!apiKey.trim() || apiKey.length > 8192 || !validKeyName) {
      return NextResponse.json({ error: "Provide a non-empty API key and valid header or environment variable name" }, { status: 400 });
    }

    const { writeMcpSecret } = await import("@/lib/ai/mcp/secrets");
    await writeMcpSecret(`mcp_${config.id}_${apiKeyName}`, apiKey);
    const { deleteMcpSecret } = await import("@/lib/ai/mcp/secrets");
    if (config.auth?.method === "oauth") {
      await deleteMcpSecret(`mcp_${config.id}_access_token`);
      await deleteMcpSecret(`mcp_${config.id}_refresh_token`);
      await deleteMcpSecret(`mcp_${config.id}_token_expires_at`);
    } else if (config.auth?.method === "api_key" && config.auth.apiKeyName !== apiKeyName) {
      await deleteMcpSecret(`mcp_${config.id}_${config.auth.apiKeyName}`);
    }

    updateMcpServer(config.id, {
      auth: { method: "api_key", status: "configured", lastAuthenticatedAt: Date.now(), apiKeyName },
    });

    return NextResponse.json({ ok: true, authStatus: "configured" });
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const serverId = url.searchParams.get("serverId");
  if (!serverId) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const servers = getMcpServerConfigs();
  const config = servers.find((s) => s.id === serverId);
  if (!config) {
    return NextResponse.json({ error: "Unknown server" }, { status: 404 });
  }

  // Clear stored auth secrets.
  const { deleteMcpSecret } = await import("@/lib/ai/mcp/secrets");
  if (config.auth?.method === "oauth") {
    await deleteMcpSecret(`mcp_${config.id}_access_token`);
    await deleteMcpSecret(`mcp_${config.id}_refresh_token`);
    await deleteMcpSecret(`mcp_${config.id}_token_expires_at`);
  } else if (config.auth?.method === "api_key" && config.auth.apiKeyName) {
    await deleteMcpSecret(`mcp_${config.id}_${config.auth.apiKeyName}`);
  }

  updateMcpServer(config.id, {
    auth: { method: config.auth?.method ?? "none", status: "not_configured" },
  });

  return NextResponse.json({ ok: true, authStatus: "not_configured" });
}
