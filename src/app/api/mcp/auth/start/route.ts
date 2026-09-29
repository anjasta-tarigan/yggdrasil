import { NextResponse } from "next/server";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";
import { createHmac, createHash } from "crypto";

export const dynamic = "force-dynamic";

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
  serverName: string;
  authUrl: string;
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

  const { serverName, authUrl, redirectUri } = body;
  const scopes = body.scopes ?? ["mcp"];

  if (!serverName || typeof serverName !== "string") {
    return NextResponse.json({ error: "Missing serverName" }, { status: 400 });
  }
  if (!authUrl || typeof authUrl !== "string") {
    return NextResponse.json({ error: "Missing authUrl" }, { status: 400 });
  }
  if (!redirectUri || typeof redirectUri !== "string") {
    return NextResponse.json({ error: "Missing redirectUri" }, { status: 400 });
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
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint?: string;
      client_registration_types?: string[];
      scopes_supported?: string[];
    };

    const requestedScopes = scopes.length > 0 ? scopes : (metadata.scopes_supported ?? ["mcp"]);

    // Determine or register a client ID. For now, use a deterministic
    // client_id derived from the server name. A full implementation
    // would use dynamic client registration if the server supports it.
    let clientId = `yggdrasil-${createHash("sha256").update(serverName).digest("hex").slice(0, 12)}`;

    // If the server supports dynamic client registration, register now.
    if (metadata.registration_endpoint) {
      try {
        await assertSafeUrl(metadata.registration_endpoint);
        const regRes = await fetch(metadata.registration_endpoint, {
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

    // Build the authorization URL with a signed state token.
    const state = encodeState({
      serverName,
      clientId,
      scopes: requestedScopes,
      redirectUri,
      tokenEndpoint: metadata.token_endpoint,
    });

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

/** Decode and verify a state token. Returns null if invalid. */
export function decodeState(token: string): Record<string, unknown> | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", getAuthSecret()).update(body).digest("base64url");
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

function getAuthSecret(): string {
  const secret = process.env.APP_SECRET ?? "dev-secret-change-me";
  return secret;
}
