import { NextResponse } from "next/server";
import { consumeOAuthState, decodeState } from "../start/route";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";
import { writeMcpSecret } from "@/lib/ai/mcp/secrets";
import { getMcpServerConfigs, updateMcpServer } from "@/lib/ai/mcp/manager";

export const dynamic = "force-dynamic";

/**
 * OAuth callback endpoint.
 *
 * The McpAuthDialog opens the auth URL in a new tab. When the provider
 * redirects back here with ?code=...&state=..., we exchange the code for
 * tokens, store them in the secrets store, update the server's auth status,
 * and redirect the browser tab to a simple "auth complete" page that
 * signals the opener via localStorage (postMessage).
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(
      `${url.origin}/settings?tab=mcp&auth_error=missing_code_or_state`
    );
  }

  const stateData = decodeState(state);
  if (!stateData) {
    return NextResponse.redirect(
      `${url.origin}/settings?tab=mcp&auth_error=invalid_state`
    );
  }
  if (!consumeOAuthState(stateData.stateId as string)) {
    return NextResponse.redirect(`${url.origin}/settings?tab=mcp&auth_error=expired_state`);
  }

  const serverName = stateData.serverName as string;
  const serverId = stateData.serverId as string;
  const clientId = stateData.clientId as string;
  const tokenEndpoint = stateData.tokenEndpoint as string;
  const redirectUri = stateData.redirectUri as string;

  if (!serverId || !tokenEndpoint || !clientId || !redirectUri) {
    return NextResponse.redirect(
      `${url.origin}/settings?tab=mcp&auth_error=invalid_state`
    );
  }

  if (!getMcpServerConfigs().some((server) => server.id === serverId)) {
    return NextResponse.redirect(`${url.origin}/settings?tab=mcp&auth_error=unknown_server`);
  }

  try {
    await assertSafeUrl(tokenEndpoint);

    // Exchange the authorization code for tokens.
    const tokenRes = await secureFetch(tokenEndpoint, {
      method: "POST",
      timeoutMs: 10_000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
      }).toString(),
    });

    if (!tokenRes.ok) {
      return NextResponse.redirect(
        `${url.origin}/settings?tab=mcp&auth_error=token_exchange_failed`
      );
    }

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (typeof tokenData.access_token !== "string" || !tokenData.access_token) {
      return NextResponse.redirect(`${url.origin}/settings?tab=mcp&auth_error=invalid_token_response`);
    }

    // Store tokens in the secrets store, keyed by server id to match
    // the resolution scheme used by overlayAuthCredentials in the manager.
    await writeMcpSecret(`mcp_${serverId}_access_token`, tokenData.access_token);
    const { deleteMcpSecret } = await import("@/lib/ai/mcp/secrets");
    const current = getMcpServerConfigs().find((server) => server.id === serverId);
    if (current?.auth?.method === "api_key" && current.auth.apiKeyName) await deleteMcpSecret(`mcp_${serverId}_${current.auth.apiKeyName}`);
    if (tokenData.refresh_token) await writeMcpSecret(`mcp_${serverId}_refresh_token`, tokenData.refresh_token);
    else await deleteMcpSecret(`mcp_${serverId}_refresh_token`);
    if (typeof tokenData.expires_in === "number" && Number.isFinite(tokenData.expires_in) && tokenData.expires_in > 0) {
      await writeMcpSecret(`mcp_${serverId}_token_expires_at`, String(Date.now() + tokenData.expires_in * 1000));
    } else await deleteMcpSecret(`mcp_${serverId}_token_expires_at`);

    // Update the server's auth status so the polling endpoint detects completion.
    const scopes = (stateData.scopes as string[] | undefined) ?? undefined;
    updateMcpServer(serverId, {
      auth: {
        method: "oauth",
        status: "configured",
        lastAuthenticatedAt: Date.now(),
        oauthScopes: scopes,
      },
    });

    // Redirect to a simple page that signals completion to the opener tab.
    return NextResponse.redirect(
      `${url.origin}/api/mcp/auth/complete?serverName=${encodeURIComponent(serverName)}&serverId=${encodeURIComponent(serverId)}`
    );
  } catch (err) {
    console.error("[api/mcp/auth/callback] Token exchange failed:", err);
    return NextResponse.redirect(
      `${url.origin}/settings?tab=mcp&auth_error=exchange_failed`
    );
  }
}
