/**
 * OAuth discovery for MCP servers.
 *
 * Implements the two-step discovery from the MCP authorization spec:
 *  1. OAuth 2.0 Protected Resource Metadata (RFC 9728) at the MCP server.
 *  2. OAuth 2.0 Authorization Server Metadata (RFC 8414), with an OpenID
 *     Connect Discovery fallback for providers that only publish that.
 *
 * Both well-known URL shapes are tried: the path-suffixed form from the RFCs
 * and the root form that many MCP servers publish in practice.
 */

import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";

export type OAuthServerMetadata = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
};

export type OAuthDiscoveryResult = {
  resourceUrl: string;
  issuer: string;
  resourceMetadataUrl: string;
  authorizationServerMetadataUrl: string;
  metadata: OAuthServerMetadata;
};

export type FetchJsonResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
};

export type FetchJson = (url: string) => Promise<FetchJsonResult>;

export type DiscoverOAuthOptions = {
  /** Injectable fetcher for tests. Defaults to an SSRF-safe JSON fetch. */
  fetchJson?: FetchJson;
  timeoutMs?: number;
};

export class OAuthDiscoveryError extends Error {
  constructor(
    readonly stage: "resource_metadata" | "authorization_server_metadata",
    message: string
  ) {
    super(message);
    this.name = "OAuthDiscoveryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripTrailingSlash(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  return pathname.replace(/\/+$/, "");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** Candidate URLs for RFC 9728 protected resource metadata, in preference order. */
export function resourceMetadataUrls(resource: URL): string[] {
  const path = stripTrailingSlash(resource.pathname);
  return dedupe([
    `${resource.origin}/.well-known/oauth-protected-resource${path}`,
    `${resource.origin}/.well-known/oauth-protected-resource`,
  ]);
}

/** Candidate URLs for RFC 8414 / OIDC authorization server metadata. */
export function authorizationServerMetadataUrls(issuer: URL): string[] {
  const path = stripTrailingSlash(issuer.pathname);
  return dedupe([
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/oauth-authorization-server`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
    `${issuer.origin}/.well-known/openid-configuration`,
  ]);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > maxLength) continue;
    if (!result.includes(entry)) result.push(entry);
    if (result.length >= maxItems) break;
  }
  return result;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function toServerMetadata(data: Record<string, unknown>): OAuthServerMetadata | null {
  const authorizationEndpoint = httpUrl(data.authorization_endpoint);
  const tokenEndpoint = httpUrl(data.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) return null;
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: httpUrl(data.registration_endpoint) ?? undefined,
    scopesSupported: stringArray(data.scopes_supported, 32, 128),
  };
}

function defaultFetchJson(timeoutMs: number): FetchJson {
  return async (url) => {
    await assertSafeUrl(url);
    const response = await secureFetch(url, {
      timeoutMs,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return { ok: false, status: response.status, data: null };
    try {
      const data: unknown = await response.json();
      return { ok: true, status: response.status, data: isRecord(data) ? data : null };
    } catch {
      return { ok: true, status: response.status, data: null };
    }
  };
}

/** Fetch and validate one authorization server metadata document. */
export async function fetchAuthorizationServerMetadata(
  metadataUrl: string,
  options: DiscoverOAuthOptions = {}
): Promise<OAuthServerMetadata> {
  const fetchJson = options.fetchJson ?? defaultFetchJson(options.timeoutMs ?? 10_000);
  const result = await fetchJson(metadataUrl);
  const metadata = result.ok && result.data ? toServerMetadata(result.data) : null;
  if (!metadata) {
    throw new OAuthDiscoveryError(
      "authorization_server_metadata",
      `Authorization server metadata was not usable (status ${result.status}).`
    );
  }
  return metadata;
}

type AuthorizationServerResolution =
  | { found: true; issuer: URL; metadataUrl: string; metadata: OAuthServerMetadata }
  | { found: false; status?: number };

/** Try every RFC 8414/OIDC candidate for each issuer, in order. */
async function resolveAuthorizationServer(
  issuers: URL[],
  fetchJson: FetchJson
): Promise<AuthorizationServerResolution> {
  let lastStatus: number | undefined;

  for (const issuer of issuers) {
    if (issuer.protocol !== "https:" && issuer.protocol !== "http:") continue;

    for (const metadataUrl of authorizationServerMetadataUrls(issuer)) {
      try {
        const result = await fetchJson(metadataUrl);
        if (!result.ok || !result.data) {
          lastStatus ??= result.status;
          continue;
        }
        const metadata = toServerMetadata(result.data);
        if (!metadata) continue;
        return { found: true, issuer, metadataUrl, metadata };
      } catch {
        // Try the next candidate shape.
      }
    }
  }

  return { found: false, status: lastStatus };
}

function httpIssuers(values: string[], fallback: URL): URL[] {
  const issuers: URL[] = [];
  for (const value of values) {
    try {
      const issuer = new URL(value);
      if (issuer.protocol === "https:" || issuer.protocol === "http:") issuers.push(issuer);
    } catch {
      // Ignore unparsable issuer values and keep trying the rest.
    }
  }
  return issuers.length > 0 ? issuers : [fallback];
}

/**
 * Run full OAuth discovery for an HTTP/SSE MCP server URL.
 *
 * Falls back to authorization-server metadata published directly at the
 * resource origin when protected-resource metadata is absent, which older
 * MCP servers rely on.
 *
 * Throws `OAuthDiscoveryError` when neither document can be found or parsed.
 */
export async function discoverOAuth(
  resourceUrl: string | URL,
  options: DiscoverOAuthOptions = {}
): Promise<OAuthDiscoveryResult> {
  const resource = typeof resourceUrl === "string" ? new URL(resourceUrl) : resourceUrl;
  const fetchJson = options.fetchJson ?? defaultFetchJson(options.timeoutMs ?? 10_000);

  let resourceMetadata: Record<string, unknown> | null = null;
  let resourceMetadataUrl = "";
  let resourceStatus: number | undefined;

  for (const candidate of resourceMetadataUrls(resource)) {
    try {
      const result = await fetchJson(candidate);
      if (result.ok && result.data) {
        resourceMetadata = result.data;
        resourceMetadataUrl = candidate;
        break;
      }
      resourceStatus ??= result.status;
    } catch {
      // Try the next candidate. A failing host should not stop the root
      // fallback from being attempted.
    }
  }

  if (!resourceMetadata) {
    // Backwards compatibility: MCP servers predating RFC 9728 publish only
    // authorization-server metadata at their own origin.
    const fallback = await resolveAuthorizationServer([resource], fetchJson);
    if (!fallback.found) {
      throw new OAuthDiscoveryError(
        "resource_metadata",
        resourceStatus
          ? `Protected resource metadata was not available (status ${resourceStatus}).`
          : "Protected resource metadata could not be reached."
      );
    }
    return {
      resourceUrl: resource.toString(),
      issuer: fallback.issuer.toString(),
      resourceMetadataUrl: "",
      authorizationServerMetadataUrl: fallback.metadataUrl,
      metadata: fallback.metadata,
    };
  }

  // RFC 9728 allows omitting authorization_servers; in that case the resource
  // server origin is also the authorization server.
  const declaredIssuers = stringArray(resourceMetadata.authorization_servers, 8, 2048);
  const resolved = await resolveAuthorizationServer(
    httpIssuers(declaredIssuers, new URL(resource.origin)),
    fetchJson
  );

  if (!resolved.found) {
    throw new OAuthDiscoveryError(
      "authorization_server_metadata",
      resolved.status
        ? `Authorization server metadata was not available (status ${resolved.status}).`
        : "Authorization server metadata could not be reached."
    );
  }

  return {
    resourceUrl: resource.toString(),
    issuer: resolved.issuer.toString(),
    resourceMetadataUrl,
    authorizationServerMetadataUrl: resolved.metadataUrl,
    metadata: resolved.metadata,
  };
}
