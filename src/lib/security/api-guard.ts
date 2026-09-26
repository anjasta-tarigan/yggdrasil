import crypto from "node:crypto";
import { syslog } from "@/lib/observability/log-store";

import { NextResponse } from "next/server";
import { env, refreshEnv } from "@/env";

/**
 * Shared request guard for the local REST API surface.
 *
 * Extracted from `src/app/api/projects/guard.ts` so the projects routes and the
 * system routes validate callers through one implementation instead of a
 * third near-identical copy (Rule 01: DRY / Rule of Three).
 */

/**
 * Constant-time comparison of two strings using crypto.timingSafeEqual.
 * Checks byte lengths first to prevent timing side-channels and RangeErrors.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Standard loopback hostnames (including bracketed IPv6 literals). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/**
 * True when the request reached the server over the local loopback interface.
 *
 * Spec §3.8.1 binds the listener to `127.0.0.1`, so only local processes can
 * connect at all. That binding is the primary trust boundary; the bearer token
 * below covers the non-local case (e.g. an explicit `HOSTNAME=0.0.0.0` opt-in
 * or a reverse proxy in front of the app).
 *
 * Note: Next.js populates `x-forwarded-for` itself on every request — a plain
 * loopback call arrives as `x-forwarded-for: 127.0.0.1`. Presence of the header
 * therefore proves nothing; only a non-loopback *value* marks the caller as
 * remote.
 */
export function isLocalRequest(req: Request): boolean {
  // A forwarding chain that starts off-machine means the request is remote,
  // even when it ultimately arrives over loopback (reverse proxy / tunnel).
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop && !isLoopbackHostname(firstHop)) {
      return false;
    }
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && !isLoopbackHostname(realIp)) {
    return false;
  }

  const forwarded = req.headers.get("forwarded");
  if (forwarded && /for=/i.test(forwarded)) {
    const value = forwarded.split(",")[0] ?? "";
    const match = /for="?\[?([^";\]]+)\]?"?/i.exec(value);
    const forHost = match?.[1]?.trim();
    if (forHost && !isLoopbackHostname(forHost)) {
      return false;
    }
  }

  const hostHeader = req.headers.get("host");
  let hostname: string | null = null;

  if (hostHeader) {
    try {
      hostname = new URL(
        hostHeader.includes("://") ? hostHeader : `http://${hostHeader}`
      ).hostname;
    } catch (err) {
      syslog("debug", "guard", `Error: ${err instanceof Error ? err.message : String(err)}`);
      hostname = null;
    }
  }

  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch (err) {
      syslog("debug", "guard", `Error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  return isLoopbackHostname(hostname);
}

/**
 * Validates whether an origin or referer URL belongs to localhost or matches the host header.
 */
function isAllowedHost(urlStr: string, hostHeader: string | null): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Standard loopback hostnames
    if (isLoopbackHostname(hostname)) {
      return true;
    }

    // Check against host header if available
    if (hostHeader) {
      try {
        const expectedUrl = new URL(
          hostHeader.includes("://") ? hostHeader : `http://${hostHeader}`
        );
        if (hostname === expectedUrl.hostname.toLowerCase()) {
          const expectedPort = expectedUrl.port;
          if (!expectedPort || !url.port || expectedPort === url.port) {
            return true;
          }
        }
      } catch (err) {
        syslog("debug", "guard", `Error: ${err instanceof Error ? err.message : String(err)}`);
        // Invalid host header format
      }
    }

    return false;
  } catch (err) {
    syslog("debug", "guard", `Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Security guard for project API requests (Spec §3.8):
 * - Caller Authentication: Validates Bearer token against APP_SECRET. Loopback
 *   requests are trusted (the listener is loopback-bound, §3.8.1); the token is
 *   required for non-local callers.
 *
 *   NOTE: this deliberately relaxes spec §3.8.3 for the loopback case. The
 *   in-app browser UI has no login step and sends no Authorization header, so
 *   demanding a token from it would 401 every project call. The loopback
 *   listener binding is the primary boundary; the shared secret guards the
 *   non-local case (explicit HOSTNAME=0.0.0.0 opt-in or a reverse proxy).
 *   See the accepted-deviation note in the Projects design spec §3.8.3.
 * - CSRF / Origin Validation: Validates Origin and Referer on mutating methods
 *   (POST, PATCH, DELETE, PUT). A mutating request carrying neither header is
 *   rejected — a browser sends `Origin` on every non-GET request, so its
 *   absence marks a forged or non-browser caller.
 * - Content-Type Validation: Requires application/json on requests with JSON body.
 *
 * Returns NextResponse on validation failure, or null if validation passes.
 */
export function validateProjectApiRequest(
  req: Request,
  options?: { requireJsonBody?: boolean }
): NextResponse | null {
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  const secret = currentEnv.APP_SECRET;
  const authHeader = req.headers.get("authorization");
  const isLocal = isLocalRequest(req);

  // 1. Caller Authentication
  //
  // Loopback requests are already gated by the listener binding (§3.8.1):
  // nothing off-device can reach a 127.0.0.1-bound server. The in-app browser
  // UI has no login step and sends no Authorization header, so demanding a
  // token from it would make every project call 401. The shared secret
  // therefore guards the *non-local* case, and any Bearer token that is
  // offered is validated regardless of origin.
  if (secret && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!timingSafeEqualStr(token, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (!isLocal) {
    // Non-local callers must present the shared secret.
    return NextResponse.json(
      {
        error: secret
          ? "Unauthorized"
          : "Unauthorized: APP_SECRET required in production",
      },
      { status: 401 }
    );
  }

  // 2. CSRF / Origin / Referer Validation on mutating requests
  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PATCH", "DELETE", "PUT"].includes(method);

  if (isMutating) {
    let hostHeader = req.headers.get("host");
    if (!hostHeader) {
      try {
        hostHeader = new URL(req.url).host;
      } catch (err) {
        syslog("debug", "guard", `Error: ${err instanceof Error ? err.message : String(err)}`);
        hostHeader = null;
      }
    }

    const origin = req.headers.get("origin");
    if (origin) {
      if (!isAllowedHost(origin, hostHeader)) {
        return NextResponse.json(
          { error: "Forbidden: invalid origin" },
          { status: 403 }
        );
      }
    }

    const referer = req.headers.get("referer");
    if (referer) {
      if (!isAllowedHost(referer, hostHeader)) {
        return NextResponse.json(
          { error: "Forbidden: invalid referer" },
          { status: 403 }
        );
      }
    }

    // Neither header present: a browser sends `Origin` on every non-GET
    // request, so this is a forged/non-browser mutation and must be rejected.
    if (!origin && !referer) {
      return NextResponse.json(
        { error: "Forbidden: Origin or Referer header required" },
        { status: 403 }
      );
    }

    // 3. Content-Type Validation
    const contentType = req.headers.get("content-type");
    const expectsBody =
      options?.requireJsonBody ?? (method === "POST" || method === "PATCH");

    if (expectsBody) {
      if (!contentType || !contentType.toLowerCase().includes("application/json")) {
        return NextResponse.json(
          { error: "Content-Type must be application/json" },
          { status: 415 }
        );
      }
    } else if (contentType && !contentType.toLowerCase().includes("application/json")) {
      return NextResponse.json(
        { error: "Content-Type must be application/json" },
        { status: 415 }
      );
    }
  }

  return null;
}
