import { NextResponse } from "next/server";
import { getMcpServerConfigs, updateMcpServer } from "@/lib/ai/mcp/manager";
import {
  discoverOAuth,
  OAuthDiscoveryError,
} from "@/lib/ai/mcp/oauth-discovery";

export const dynamic = "force-dynamic";

const OAUTH_SECRET_SUFFIXES = [
  "access_token",
  "refresh_token",
  "token_expires_at",
  "client_id",
  "client_secret",
  "token_endpoint",
  "resource",
] as const;

async function clearOAuthSecrets(serverId: string): Promise<void> {
  const { deleteMcpSecret } = await import("@/lib/ai/mcp/secrets");
  await Promise.all(
    OAUTH_SECRET_SUFFIXES.map((suffix) => deleteMcpSecret(`mcp_${serverId}_${suffix}`))
  );
}

/**
 * OAuth capability probe for the Settings UI.
 *
 * Returns { oauth: true, authUrl, scopes } when RFC 9728 + RFC 8414 discovery
 * succeeds. Failures return oauth: false plus a human-readable reason instead
 * of a 5xx, so the dialog can explain why OAuth is unavailable.
 */
export async function GET(req: Request) {
  const serverId = new URL(req.url).searchParams.get("serverId");
  const config = getMcpServerConfigs().find((server) => server.id === serverId);
  if (!config) return NextResponse.json({ error: "Unknown MCP server" }, { status: 404 });
  if (!config.url || (config.transport !== "http" && config.transport !== "sse")) {
    return NextResponse.json({ oauth: false, apiKey: true });
  }

  try {
    const discovery = await discoverOAuth(config.url);
    return NextResponse.json({
      oauth: true,
      authUrl: discovery.authorizationServerMetadataUrl,
      scopes: discovery.metadata.scopesSupported,
      apiKey: true,
    });
  } catch (error) {
    const reason = error instanceof OAuthDiscoveryError
      ? error.message
      : "Could not determine whether this server supports OAuth.";
    console.warn("[api/mcp/auth] OAuth capability discovery failed", reason);
    return NextResponse.json({ oauth: false, apiKey: true, reason });
  }
}

/**
 * MCP authentication management for the Settings UI.
 *
 * POST { serverId, method: "api_key" | "none" } - select a non-OAuth method.
 * POST { serverId, apiKey, apiKeyName }         - store an API key.
 * DELETE { serverId }                           - clear auth state.
 *
 * OAuth uses the signed start/callback flow at /api/mcp/auth/start.
 */

interface AuthRequest {
  serverId?: string;
  method?: "oauth" | "api_key" | "none";
  code?: string;
  apiKey?: string;
  apiKeyName?: string;
}

export async function POST(req: Request) {
  let body: AuthRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { serverId, method, code, apiKey, apiKeyName } = body;

  if (typeof serverId !== "string" || !serverId) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const servers = getMcpServerConfigs();
  const config = servers.find((s) => s.id === serverId);
  if (!config) {
    return NextResponse.json({ error: `Unknown MCP server id "${serverId}"` }, { status: 404 });
  }

  if (method === "oauth" || code) {
    return NextResponse.json({ error: "Use the signed OAuth start and callback flow" }, { status: 410 });
  }

  // --- Select auth method (credentials arrive in a later step) ---
  if (method && !apiKey) {
    if (method === "api_key") {
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
    if (config.auth?.method === "oauth") {
      await clearOAuthSecrets(config.id);
    } else if (config.auth?.method === "api_key" && config.auth.apiKeyName !== apiKeyName) {
      const { deleteMcpSecret } = await import("@/lib/ai/mcp/secrets");
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

  if (config.auth?.method === "oauth") {
    await clearOAuthSecrets(config.id);
  } else if (config.auth?.method === "api_key" && config.auth.apiKeyName) {
    const { deleteMcpSecret } = await import("@/lib/ai/mcp/secrets");
    await deleteMcpSecret(`mcp_${config.id}_${config.auth.apiKeyName}`);
  }

  updateMcpServer(config.id, {
    auth: { method: config.auth?.method ?? "none", status: "not_configured" },
  });

  return NextResponse.json({ ok: true, authStatus: "not_configured" });
}
