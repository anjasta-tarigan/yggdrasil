import crypto from "node:crypto";
import { syslog } from "@/lib/observability/log-store";

import { NextResponse } from "next/server";
import { env, refreshEnv } from "@/env";

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

/**
 * Validates whether an origin or referer URL belongs to localhost or matches the host header.
 */
function isAllowedHost(urlStr: string, hostHeader: string | null): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    // Standard loopback hostnames
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
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
 * - Caller Authentication: Validates Bearer token if APP_SECRET is set or in production.
 * - CSRF / Origin Validation: Validates Origin and Referer on mutating methods (POST, PATCH, DELETE).
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
  const isProd = currentEnv.NODE_ENV === "production";
  const authHeader = req.headers.get("authorization");

  // 1. Caller Authentication
  if (secret) {
    if (isProd || authHeader) {
      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const token = authHeader.slice(7).trim();
      if (!timingSafeEqualStr(token, secret)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }
  } else if (isProd) {
    return NextResponse.json(
      { error: "Unauthorized: APP_SECRET required in production" },
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

/**
 * Alias for validateProjectApiRequest matching the task specification.
 */
export function validateProjectRequest(
  req: Request,
  requireJsonBody = false
): NextResponse | null {
  return validateProjectApiRequest(req, { requireJsonBody });
}
