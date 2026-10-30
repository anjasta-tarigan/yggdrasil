import { NextRequest, NextResponse } from "next/server";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";
import { deleteMcpSecret, writeMcpSecret } from "@/lib/ai/mcp/secrets";
import { getMcpServerConfigs, updateMcpServer } from "@/lib/ai/mcp/manager";
import {
  decodeOAuthState,
  oauthErrorCookieName,
  oauthErrorCookieOptions,
  oauthFlowCookieName,
  oauthFlowCookieOptions,
  openOAuthFlow,
} from "@/lib/ai/mcp/oauth-flow";

export const dynamic = "force-dynamic";

/**
 * OAuth callback endpoint.
 *
 * The provider redirects the popup here with ?code=...&state=.... We verify the
 * signed state and the sealed flow cookie, redeem the code with its PKCE
 * verifier, store the tokens, mark the server configured, and redirect to a
 * small completion page. Failures land on the same page with an error code and
 * also set a short-lived cookie so the settings tab's status poll can stop
 * waiting even when `window.opener` was severed by the provider.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  let stateData: Record<string, unknown> | null = null;
  if (state) {
    try {
      stateData = decodeOAuthState(state);
    } catch {
      stateData = null;
    }
  }

  const serverId = typeof stateData?.serverId === "string" ? stateData.serverId : undefined;
  const serverName = typeof stateData?.serverName === "string" ? stateData.serverName : undefined;
  const stateId = typeof stateData?.stateId === "string" ? stateData.stateId : undefined;

  if (providerError) {
    const errorCode = providerError === "access_denied" ? "access_denied" : "authorization_failed";
    console.warn(`[api/mcp/auth/callback] Provider returned "${providerError}" for ${serverName ?? serverId ?? "unknown server"}`);
    return failure(req, url.origin, errorCode, serverId, serverName, stateId);
  }

  if (!code || !state) {
    return failure(req, url.origin, "missing_code_or_state", serverId, serverName, stateId);
  }
  if (!stateData) {
    return failure(req, url.origin, "invalid_state");
  }
  if (!serverId || !stateId) {
    return failure(req, url.origin, "invalid_state");
  }

  const flow = openOAuthFlow(req.cookies.get(oauthFlowCookieName(stateId))?.value);
  if (!flow || flow.stateId !== stateId || flow.serverId !== serverId) {
    return failure(req, url.origin, "expired_state", serverId, serverName, stateId);
  }

  if (!getMcpServerConfigs().some((server) => server.id === serverId)) {
    return failure(req, url.origin, "unknown_server", serverId, serverName, stateId);
  }

  try {
    await assertSafeUrl(flow.tokenEndpoint);

    // Redeem the authorization code. PKCE and the resource indicator are
    // required by the MCP authorization spec; the client secret is included
    // only when dynamic client registration issued one.
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      client_id: flow.clientId,
      code_verifier: flow.codeVerifier,
      resource: flow.resource,
    });
    if (flow.clientSecret) form.set("client_secret", flow.clientSecret);

    const tokenRes = await secureFetch(flow.tokenEndpoint, {
      method: "POST",
      timeoutMs: 10_000,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });

    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => "");
      console.warn(
        `[api/mcp/auth/callback] Token exchange failed for "${serverName ?? serverId}" (${tokenRes.status}):`,
        detail.slice(0, 2_000)
      );
      return failure(req, url.origin, "token_exchange_failed", serverId, serverName, stateId);
    }

    const tokenData = await tokenRes.json().catch(() => null) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!tokenData || typeof tokenData.access_token !== "string" || !tokenData.access_token) {
      return failure(req, url.origin, "invalid_token_response", serverId, serverName, stateId);
    }

    // Store tokens in the secrets store, keyed by server id to match the
    // resolution scheme used by overlayAuthCredentials in the manager.
    await writeMcpSecret(`mcp_${serverId}_access_token`, tokenData.access_token);
    if (typeof tokenData.refresh_token === "string" && tokenData.refresh_token) {
      await writeMcpSecret(`mcp_${serverId}_refresh_token`, tokenData.refresh_token);
    } else {
      await deleteMcpSecret(`mcp_${serverId}_refresh_token`);
    }

    const expiresIn = typeof tokenData.expires_in === "number"
      ? tokenData.expires_in
      : typeof tokenData.expires_in === "string"
        ? Number(tokenData.expires_in)
        : Number.NaN;
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      await writeMcpSecret(`mcp_${serverId}_token_expires_at`, String(Date.now() + expiresIn * 1000));
    } else {
      await deleteMcpSecret(`mcp_${serverId}_token_expires_at`);
    }

    // Persist the client identity and token endpoint so refresh does not have
    // to re-derive them (and does not use a different client id).
    await writeMcpSecret(`mcp_${serverId}_client_id`, flow.clientId);
    if (flow.clientSecret) await writeMcpSecret(`mcp_${serverId}_client_secret`, flow.clientSecret);
    else await deleteMcpSecret(`mcp_${serverId}_client_secret`);
    await writeMcpSecret(`mcp_${serverId}_token_endpoint`, flow.tokenEndpoint);
    await writeMcpSecret(`mcp_${serverId}_resource`, flow.resource);

    const current = getMcpServerConfigs().find((server) => server.id === serverId);
    if (current?.auth?.method === "api_key" && current.auth.apiKeyName) {
      await deleteMcpSecret(`mcp_${serverId}_${current.auth.apiKeyName}`);
    }

    updateMcpServer(serverId, {
      auth: {
        method: "oauth",
        status: "configured",
        lastAuthenticatedAt: Date.now(),
        oauthScopes: flow.scopes.length > 0 ? flow.scopes : undefined,
      },
    });

    const params = new URLSearchParams({ serverId });
    if (serverName) params.set("serverName", serverName);
    const response = NextResponse.redirect(`${url.origin}/api/mcp/auth/complete?${params.toString()}`);
    response.cookies.set(oauthFlowCookieName(stateId), "", oauthFlowCookieOptions(req, 0));
    response.cookies.set(oauthErrorCookieName(serverId), "", { ...oauthErrorCookieOptions(req), maxAge: 0 });
    return response;
  } catch (err) {
    console.error("[api/mcp/auth/callback] Token exchange failed:", err);
    return failure(req, url.origin, "exchange_failed", serverId, serverName, stateId);
  }
}

function failure(
  req: NextRequest,
  origin: string,
  code: string,
  serverId?: string,
  serverName?: string,
  stateId?: string
): NextResponse {
  const params = new URLSearchParams({ error: code });
  if (serverId) params.set("serverId", serverId);
  if (serverName) params.set("serverName", serverName);

  const response = NextResponse.redirect(`${origin}/api/mcp/auth/complete?${params.toString()}`);
  if (stateId) response.cookies.set(oauthFlowCookieName(stateId), "", oauthFlowCookieOptions(req, 0));
  if (serverId) response.cookies.set(oauthErrorCookieName(serverId), code, oauthErrorCookieOptions(req));
  return response;
}
