import crypto from "node:crypto";
import { syslog } from "@/lib/observability/log-store";
import { NextResponse } from "next/server";
import { env, refreshEnv } from "@/env";

/**
 * Shared CSRF / localhost-origin guard for the REST API surface.
 *
 * Yggdrasil is a no-login, loopback-bound app: the browser UI sends no
 * Authorization header, so loopback trust is the boundary. The real threat this
 * guards against is drive-by CSRF from a webpage the user visits — a plain
 * `fetch('http://127.0.0.1:PORT/api/...', { method: 'POST' })` reaches the
 * server without any CORS preflight. A browser always sends `Origin` on a
 * same-origin mutation, so a mutation carrying neither `Origin` nor `Referer`
 * did not come from our own UI and must be rejected.
 *
 * This module centralises the enforcement so the rule is applied uniformly to
 * every mutating route (see `src/proxy.ts`). Per-route guards still exist for
 * the already-protected prefixes and layer extra concerns (rate limiting); the
 * proxy skips those prefixes so they are not enforced twice.
 */

/** Constant-time comparison of two strings. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/**
 * True when the request reached us over loopback, accounting for the forwarding
 * headers a reverse proxy / tunnel would set. A chain that starts off-machine
 * marks the caller as remote even if it ultimately arrives on loopback.
 */
export function isLocalRequest(req: Request): boolean {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop && !isLoopbackHostname(firstHop)) return false;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && !isLoopbackHostname(realIp)) return false;

  const forwarded = req.headers.get("forwarded");
  if (forwarded && /for=/i.test(forwarded)) {
    const value = forwarded.split(",")[0] ?? "";
    const match = /for="?\[?([^";\]]+)\]?"?/i.exec(value);
    const forHost = match?.[1]?.trim();
    if (forHost && !isLoopbackHostname(forHost)) return false;
  }

  let hostname: string | null = null;
  const hostHeader = req.headers.get("host");
  if (hostHeader) {
    try {
      hostname = new URL(
        hostHeader.includes("://") ? hostHeader : `http://${hostHeader}`
      ).hostname;
    } catch (err) {
      syslog("debug", "csrf", `Error: ${err instanceof Error ? err.message : String(err)}`);
      hostname = null;
    }
  }

  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch (err) {
      syslog("debug", "csrf", `Error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  return isLoopbackHostname(hostname);
}

function isAllowedHost(urlStr: string, hostHeader: string | null): boolean {
  try {
    const url = new URL(urlStr);
    if (isLoopbackHostname(url.hostname)) return true;

    if (hostHeader) {
      try {
        const expected = new URL(
          hostHeader.includes("://") ? hostHeader : `http://${hostHeader}`
        );
        if (url.hostname === expected.hostname.toLowerCase()) {
          const expectedPort = expected.port;
          if (!expectedPort || !url.port || expectedPort === url.port) {
            return true;
          }
        }
      } catch (err) {
        syslog("debug", "csrf", `Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return false;
  } catch (err) {
    syslog("debug", "csrf", `Error: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

const MUTATING = new Set(["POST", "PATCH", "DELETE", "PUT"]);

export interface CsrfGuardOptions {
  /** Require a JSON body (content-type application/json) on this mutation. */
  requireJsonBody?: boolean;
}

/**
 * Enforce loopback + Origin/Referer + Content-Type on a request.
 *
 * Returns a `NextResponse` (the failure to return) or `null` if the request
 * passes. Bearer-auth'd remote callers (CLI / remote management) bypass the
 * Origin/Referer requirement because they have no Origin to send; their shared
 * secret already proves intent.
 */
export function validateCsrf(req: Request, options?: CsrfGuardOptions): NextResponse | null {
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  const secret = currentEnv.APP_SECRET;
  const authHeader = req.headers.get("authorization");
  const isLocal = isLocalRequest(req);

  let isAuthorizedRemote = false;
  if (secret && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!timingSafeEqualStr(token, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    isAuthorizedRemote = true;
  } else if (!isLocal) {
    return NextResponse.json(
      { error: secret ? "Unauthorized" : "Unauthorized: APP_SECRET required in production" },
      { status: 401 }
    );
  }

  const method = req.method.toUpperCase();
  const isMutating = MUTATING.has(method);

  if (isMutating && !isAuthorizedRemote) {
    const hostHeader = req.headers.get("host");
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");

    if (origin && !isAllowedHost(origin, hostHeader)) {
      return NextResponse.json({ error: "Forbidden: invalid origin" }, { status: 403 });
    }
    if (referer && !isAllowedHost(referer, hostHeader)) {
      return NextResponse.json({ error: "Forbidden: invalid referer" }, { status: 403 });
    }
    if (!origin && !referer) {
      return NextResponse.json(
        { error: "Forbidden: Origin or Referer header required" },
        { status: 403 }
      );
    }
  }

  // Content-Type Validation on mutating requests. Deliberately NOT inside the
  // `!isAuthorizedRemote` CSRF bypass above: a verified Bearer caller is exempt
  // from the Origin/Referer requirement (it has no Origin to send), but it must
  // still send a JSON body. Keeping this under `isMutating` alone matches the
  // web-providers guard and the pre-centralization api-guard behaviour.
  if (isMutating) {
    const contentType = req.headers.get("content-type");
    const expectsBody = options?.requireJsonBody ?? (method === "POST" || method === "PATCH");
    if (expectsBody) {
      if (!contentType || !contentType.toLowerCase().includes("application/json")) {
        return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
      }
    } else if (contentType && !contentType.toLowerCase().includes("application/json")) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
  }

  return null;
}
