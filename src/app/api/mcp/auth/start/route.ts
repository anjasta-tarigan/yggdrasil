import { NextResponse } from "next/server";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";
import { getMcpServerConfigs } from "@/lib/ai/mcp/manager";
import { createHmac, createHash, timingSafeEqual, randomUUID } from "crypto";

export const dynamic = "force-dynamic";
// shortcut: OAuth state only survives within one app process; use shared state storage if callbacks run across instances.
const pendingOAuthStates = new Map<string, number>();

/**
 * Start an OAuth authorization code flow for an MCP server.
 *
 * The server is expected to expose an OAuth authorization server at
 * /.well-known/oauth-authorization-server relative to its base URL.
 *
 * POST { serverName, authUrl, scopes[], redirectUri }
 *   - serverName: the name of the server (used to look up config)
 *   - authUrl: the OAuth metadata discovery URL (from marketplace detail)
 *   - scopes: optional override for requested scopes
 *   - redirectUri: where the provider should send the user back
 *
 * Returns { authUrl } — the authorization URL the client should redirect the
 * user to. State is encoded as a signed token so the callback can verify it.
 */

interface StartAuthRequest {
  serverName?: string;
  serverId?: string;
  authUrl?: string;
  scopes?: string[];
  redirectUri: string;
}

export async function POST(req: Request) {
  let body: StartAuthRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let { serverName, authUrl } = body;
  const { serverId, redirectUri } = body;
  const scopes = body.scopes;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 32 || scopes.some((scope) => typeof scope !== "string" || !scope || scope.length > 128))) {
    return NextResponse.json({ error: "Invalid OAuth scopes" }, { status: 400 });
  }

  if (serverId && typeof serverId === "string") {
    const server = getMcpServerConfigs().find((item) => item.id === serverId);
    if (!server) return NextResponse.json({ error: "Unknown MCP server" }, { status: 404 });
    serverName = server.name;
    if (!authUrl && server.url) {
      const endpoint = new URL(server.url);
      authUrl = `${endpoint.origin}${endpoint.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
    }
  }
  if (!serverName || typeof serverName !== "string") return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  if (!authUrl || typeof authUrl !== "string") {
    return NextResponse.json({ error: "OAuth discovery is not available for this server" }, { status: 400 });
  }
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
    await assertSafeUrl(authUrl);

    // Discover the OAuth authorization server metadata.
    const res = await secureFetch(authUrl, {
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
      client_registration_types?: string[];
      scopes_supported?: string[];
    };
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      return NextResponse.json({ error: "OAuth discovery returned incomplete metadata" }, { status: 502 });
    }
    await assertSafeUrl(metadata.authorization_endpoint);
    await assertSafeUrl(metadata.token_endpoint);

    const requestedScopes = scopes ?? (metadata.scopes_supported?.includes("mcp") ? ["mcp"] : []);

    // Determine or register a client ID. For now, use a deterministic
    // client_id derived from the server name. A full implementation
    // would use dynamic client registration if the server supports it.
    let clientId = `yggdrasil-${createHash("sha256").update(serverName).digest("hex").slice(0, 12)}`;

    // If the server supports dynamic client registration, register now.
    if (metadata.registration_endpoint) {
      try {
        await assertSafeUrl(metadata.registration_endpoint);
        const regRes = await secureFetch(metadata.registration_endpoint, {
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
            token_endpoint_auth_method: "none",
          }),
        });
        if (regRes.ok) {
          const regData = await regRes.json() as {
            client_id: string;
            client_secret?: string;
          };
          clientId = regData.client_id;
        }
      } catch (err) {
        console.warn(`[api/mcp/auth/start] Client registration failed, using fallback:`, err);
        // Fall back to the deterministic client ID.
      }
    }

    const resolvedServerId = serverId ?? await lookupServerId(serverName);

    // Build the authorization URL with a signed state token.
    const state = encodeState({
      serverName,
      serverId: resolvedServerId,
      clientId,
      scopes: requestedScopes,
      redirectUri,
      tokenEndpoint: metadata.token_endpoint,
      issuedAt: Date.now(),
      stateId: randomUUID(),
    });
    const now = Date.now();
    for (const [id, expiresAt] of pendingOAuthStates) if (expiresAt <= now) pendingOAuthStates.delete(id);
    pendingOAuthStates.set(decodeState(state)!.stateId as string, now + 10 * 60_000);

    const authEndpoint = new URL(metadata.authorization_endpoint);
    authEndpoint.searchParams.set("client_id", clientId);
    authEndpoint.searchParams.set("redirect_uri", redirectUri);
    authEndpoint.searchParams.set("response_type", "code");
    authEndpoint.searchParams.set("scope", requestedScopes.join(" "));
    authEndpoint.searchParams.set("state", state);

    return NextResponse.json({
      authUrl: authEndpoint.toString(),
      state,
    });
  } catch (err) {
    console.error("[api/mcp/auth/start] Failed to start OAuth flow:", err);
    return NextResponse.json(
      { error: "Failed to start OAuth flow" },
      { status: 502 }
    );
  }
}

/** Encode state as a base64url JSON blob with an HMAC signature. */
function encodeState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", getAuthSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Look up the server id for a given server name. */
async function lookupServerId(serverName: string): Promise<string | undefined> {
  const servers = getMcpServerConfigs();
  return servers.find((s) => s.name === serverName)?.id;
}

/** Decode and verify a state token. Returns null if invalid. */
export function decodeState(token: string): Record<string, unknown> | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", getAuthSecret()).update(body).digest("base64url");
  const actualBytes = Buffer.from(sig);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as Record<string, unknown>;
    if (typeof payload.issuedAt !== "number" || Date.now() - payload.issuedAt > 10 * 60_000 || payload.issuedAt > Date.now() + 60_000) return null;
    if (typeof payload.stateId !== "string" || typeof payload.serverId !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

export function consumeOAuthState(stateId: string): boolean {
  const expiresAt = pendingOAuthStates.get(stateId);
  if (typeof expiresAt !== "number" || expiresAt < Date.now()) return false;
  pendingOAuthStates.delete(stateId);
  return true;
}

export function registerOAuthState(stateId: string, expiresAt: number): void {
  pendingOAuthStates.set(stateId, expiresAt);
}

function getAuthSecret(): string {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) throw new Error("APP_SECRET must be configured for OAuth");
  return secret;
}
