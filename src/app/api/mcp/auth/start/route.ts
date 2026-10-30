import { NextResponse } from "next/server";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";
import { getMcpServerConfigs } from "@/lib/ai/mcp/manager";
import {
  discoverOAuth,
  fetchAuthorizationServerMetadata,
  type OAuthServerMetadata,
} from "@/lib/ai/mcp/oauth-discovery";
import {
  encodeOAuthState,
  oauthFlowCookieName,
  oauthFlowCookieOptions,
  sealOAuthFlow,
} from "@/lib/ai/mcp/oauth-flow";
import {
  createHash,
  randomBytes,
  randomUUID,
} from "crypto";

export const dynamic = "force-dynamic";

/**
 * Start an OAuth authorization-code flow for an MCP server.
 *
 * POST { serverId?, serverName?, authUrl?, scopes[], redirectUri }
 *   - serverId: configured server to authenticate (preferred)
 *   - authUrl: optional authorization-server metadata URL. When omitted (or
 *     unusable) discovery runs against the server URL.
 *   - scopes: optional override for requested scopes
 *   - redirectUri: where the provider should send the user back
 *
 * Returns { authUrl } and seals the flow (PKCE verifier, client secret, token
 * endpoint) into an HTTP-only cookie so the callback does not depend on
 * module-level state shared between route handlers.
 */

interface StartAuthRequest {
  serverName?: string;
  serverId?: string;
  authUrl?: string;
  scopes?: string[];
  redirectUri: string;
}

/** Strip fragments: RFC 8707 resource indicators must be canonical URIs. */
function canonicalResourceUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

export async function POST(req: Request) {
  let body: StartAuthRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { serverId, authUrl, redirectUri } = body;
  const scopes = body.scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 32 || scopes.some((scope) => typeof scope !== "string" || !scope || scope.length > 128))) {
    return NextResponse.json({ error: "Invalid OAuth scopes" }, { status: 400 });
  }

  const servers = getMcpServerConfigs();
  const server = servers.find((item) => (serverId ? item.id === serverId : item.name === body.serverName));
  if (!server) return NextResponse.json({ error: "Unknown MCP server" }, { status: 404 });
  if (!server.url || (server.transport !== "http" && server.transport !== "sse")) {
    return NextResponse.json({ error: "OAuth requires an HTTP or SSE MCP server" }, { status: 400 });
  }
  const serverName = server.name;

  if (!redirectUri || typeof redirectUri !== "string") {
    return NextResponse.json({ error: "Missing redirectUri" }, { status: 400 });
  }
  try {
    const redirect = new URL(redirectUri);
    const requestUrl = new URL(req.url);
    if (redirect.origin !== requestUrl.origin || redirect.pathname !== "/api/mcp/auth/callback") {
      return NextResponse.json({ error: "Invalid OAuth redirect URI" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid OAuth redirect URI" }, { status: 400 });
  }

  try {
    // Prefer the metadata URL the capability probe already resolved, but fall
    // back to full discovery when it is missing or stale.
    let metadata: OAuthServerMetadata | null = null;
    if (typeof authUrl === "string" && authUrl) {
      try {
        metadata = await fetchAuthorizationServerMetadata(authUrl);
      } catch (err) {
        console.warn("[api/mcp/auth/start] Provided metadata URL was unusable, rediscovering:", err instanceof Error ? err.message : String(err));
      }
    }
    if (!metadata) metadata = (await discoverOAuth(server.url)).metadata;

    await assertSafeUrl(metadata.authorizationEndpoint);
    await assertSafeUrl(metadata.tokenEndpoint);

    const requestedScopes = scopes && scopes.length > 0
      ? Array.from(new Set(scopes))
      : metadata.scopesSupported.includes("mcp")
        ? ["mcp"]
        : [];

    // Determine or register a client ID. When the authorization server offers
    // dynamic client registration, use it and keep any issued secret; the
    // callback needs both to redeem the code.
    let clientId = `yggdrasil-${createHash("sha256").update(server.id).digest("hex").slice(0, 12)}`;
    let clientSecret: string | undefined;

    if (metadata.registrationEndpoint) {
      try {
        await assertSafeUrl(metadata.registrationEndpoint);
        const regRes = await secureFetch(metadata.registrationEndpoint, {
          timeoutMs: 10_000,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            redirect_uris: [redirectUri],
            client_name: `Yggdrasil (${serverName})`,
            scope: requestedScopes.join(" "),
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
        if (regRes.ok) {
          const regData = await regRes.json() as {
            client_id?: unknown;
            client_secret?: unknown;
          };
          if (typeof regData.client_id === "string" && regData.client_id.length > 0) {
            clientId = regData.client_id;
          }
          if (typeof regData.client_secret === "string" && regData.client_secret.length > 0) {
            clientSecret = regData.client_secret;
          }
        } else {
          console.warn(`[api/mcp/auth/start] Client registration returned ${regRes.status}; using fallback client id`);
        }
      } catch (err) {
        console.warn(`[api/mcp/auth/start] Client registration failed, using fallback:`, err);
      }
    }

    // PKCE (OAuth 2.1 / MCP authorization spec).
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const resource = canonicalResourceUrl(server.url);
    const issuedAt = Date.now();
    const stateId = randomUUID();

    const state = encodeOAuthState({
      serverId: server.id,
      serverName,
      stateId,
      issuedAt,
    });

    const authEndpoint = new URL(metadata.authorizationEndpoint);
    authEndpoint.searchParams.set("client_id", clientId);
    authEndpoint.searchParams.set("redirect_uri", redirectUri);
    authEndpoint.searchParams.set("response_type", "code");
    if (requestedScopes.length > 0) authEndpoint.searchParams.set("scope", requestedScopes.join(" "));
    authEndpoint.searchParams.set("state", state);
    authEndpoint.searchParams.set("code_challenge", codeChallenge);
    authEndpoint.searchParams.set("code_challenge_method", "S256");
    authEndpoint.searchParams.set("resource", resource);

    const response = NextResponse.json({
      authUrl: authEndpoint.toString(),
      state,
      startedAt: issuedAt,
    });
    response.cookies.set(
      oauthFlowCookieName(stateId),
      sealOAuthFlow({
        stateId,
        serverId: server.id,
        serverName,
        clientId,
        clientSecret,
        redirectUri,
        tokenEndpoint: metadata.tokenEndpoint,
        resource,
        scopes: requestedScopes,
        codeVerifier,
        issuedAt,
      }),
      oauthFlowCookieOptions(req)
    );
    return response;
  } catch (err) {
    console.error("[api/mcp/auth/start] Failed to start OAuth flow:", err);
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to start OAuth flow: ${detail}` },
      { status: 502 }
    );
  }
}

