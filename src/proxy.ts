import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { validateCsrf } from "@/lib/security/csrf";

/**
 * Central request gate (Next.js 16 renamed `middleware` to `proxy`).
 *
 * Enforces the loopback + Origin/Referer + Content-Type guard on every mutating
 * `/api/*` route by default. This closes the gap where ~40 of ~60 mutating
 * routes shipped without any CSRF protection (a no-login loopback app is
 * reachable by drive-by `fetch` from any webpage the user visits).
 *
 * Routes that already call a per-route guard (projects, events, web-providers,
 * system) are exempt here to avoid double-enforcing. They keep their own guard
 * for extra concerns (rate limiting, feature flags).
 *
 * GET requests with side effects (OAuth redirects, etc.) are intentionally not
 * touched — browsers never send a CSRF-protected Origin on a top-level GET
 * navigation, and those endpoints are reached via first-party redirects.
 */
const EXEMPT_PREFIXES = ["/api/projects", "/api/events", "/api/web-providers", "/api/system"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();

  const isMutating = ["POST", "PATCH", "DELETE", "PUT"].includes(
    request.method.toUpperCase()
  );
  if (!isMutating) return NextResponse.next();

  if (EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const guardResult = validateCsrf(request);
  if (guardResult) return guardResult;

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
