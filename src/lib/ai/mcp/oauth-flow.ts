/**
 * Pending OAuth flow state for MCP servers.
 *
 * The authorization-code flow needs values that must not travel through the
 * browser URL (the PKCE verifier and an optional client secret). Storing them
 * in a module-level `Map` breaks as soon as Next.js evaluates two route
 * handlers in separate module graphs, and it never works across workers.
 *
 * Instead, the start route seals the flow into an encrypted, HTTP-only cookie
 * scoped to `/api/mcp/auth`. The callback reads it back from the same browser,
 * verifies it against the signed `state` parameter, and consumes the flow.
 */

import { decrypt, encrypt, isEncrypted } from "@/lib/security/encryption";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const OAUTH_FLOW_TTL_MS = 10 * 60_000;
export const OAUTH_ERROR_TTL_S = 120;
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export type PendingOAuthFlow = {
  stateId: string;
  serverId: string;
  serverName: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  tokenEndpoint: string;
  resource: string;
  scopes: string[];
  codeVerifier: string;
  issuedAt: number;
};

function isBoundedString(value: unknown, maxLength = 2048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sealOAuthFlow(flow: PendingOAuthFlow): string {
  return encrypt(JSON.stringify(flow));
}

/**
 * Decrypt and validate a sealed flow. Returns null for missing, tampered,
 * expired, or structurally invalid values.
 */
export function openOAuthFlow(value: string | null | undefined): PendingOAuthFlow | null {
  if (!value || !isEncrypted(value)) return null;
  try {
    const parsed: unknown = JSON.parse(decrypt(value));
    if (!isRecord(parsed)) return null;

    const scopes = Array.isArray(parsed.scopes)
      ? parsed.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0 && scope.length <= 128)
      : [];
    const issuedAt = parsed.issuedAt;

    if (
      !isBoundedString(parsed.stateId, 128) ||
      !isBoundedString(parsed.serverId, 128) ||
      !isBoundedString(parsed.serverName, 256) ||
      !isBoundedString(parsed.clientId, 512) ||
      !isBoundedString(parsed.redirectUri) ||
      !isBoundedString(parsed.tokenEndpoint) ||
      !isBoundedString(parsed.resource) ||
      !isBoundedString(parsed.codeVerifier, 256) ||
      typeof issuedAt !== "number"
    ) {
      return null;
    }

    const now = Date.now();
    if (now - issuedAt > OAUTH_FLOW_TTL_MS || issuedAt > now + 60_000) return null;

    return {
      stateId: parsed.stateId,
      serverId: parsed.serverId,
      serverName: parsed.serverName,
      clientId: parsed.clientId,
      clientSecret: isBoundedString(parsed.clientSecret, 512) ? parsed.clientSecret : undefined,
      redirectUri: parsed.redirectUri,
      tokenEndpoint: parsed.tokenEndpoint,
      resource: parsed.resource,
      scopes,
      codeVerifier: parsed.codeVerifier,
      issuedAt,
    };
  } catch {
    return null;
  }
}

/**
 * HMAC key for the signed `state` parameter. Kept separate from the sealed
 * flow cookie so a state token cannot be forged even if a cookie leaks.
 */
function getAuthSecret(): string {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("APP_SECRET must be configured for OAuth");
  }
  return secret;
}

/** Encode state as a base64url JSON blob with an HMAC signature. */
export function encodeOAuthState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getAuthSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

/** Decode and verify a state token. Returns null if invalid or expired. */
export function decodeOAuthState(token: string): Record<string, unknown> | null {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = createHmac("sha256", getAuthSecret()).update(body).digest("base64url");
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as Record<string, unknown>;
    if (typeof payload.issuedAt !== "number") return null;
    if (Date.now() - payload.issuedAt > OAUTH_STATE_TTL_MS) return null;
    if (payload.issuedAt > Date.now() + 60_000) return null;
    if (typeof payload.stateId !== "string" || typeof payload.serverId !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

export function oauthFlowCookieName(stateId: string): string {
  return `mcp_oauth_flow_${stateId}`;
}

export function oauthErrorCookieName(serverId: string): string {
  // Server ids are user-supplied, so hash before using one in a cookie name.
  const digest = createHash("sha256").update(serverId).digest("hex").slice(0, 16);
  return `mcp_oauth_error_${digest}`;
}

type CookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
};

function secureCookie(req: Request): boolean {
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function oauthFlowCookieOptions(req: Request, maxAgeSeconds = Math.floor(OAUTH_FLOW_TTL_MS / 1000)): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/api/mcp/auth",
    maxAge: maxAgeSeconds,
  };
}

export function oauthErrorCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(req),
    path: "/api/mcp/auth",
    maxAge: OAUTH_ERROR_TTL_S,
  };
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  missing_code_or_state: "The provider did not return an authorization code.",
  invalid_state: "The authentication response could not be verified. Please start again.",
  expired_state: "This authentication attempt expired or was already used. Please start again.",
  unknown_server: "The MCP server was removed before authentication finished.",
  authorization_failed: "The provider rejected the authorization request.",
  access_denied: "Authorization was denied in the provider.",
  token_exchange_failed: "The provider rejected the token exchange. Check the server's OAuth configuration and try again.",
  invalid_token_response: "The provider did not return an access token.",
  exchange_failed: "The token exchange failed unexpectedly. Check the server logs for details.",
};

export function describeOAuthError(code: string | null | undefined): string {
  if (!code) return "Authentication failed. Please try again.";
  return OAUTH_ERROR_MESSAGES[code] ?? "Authentication failed. Please try again.";
}
