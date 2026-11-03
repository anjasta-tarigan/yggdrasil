import { NextResponse } from "next/server";
import {
  isLoopbackHostname,
  isLocalRequest,
  validateCsrf,
} from "@/lib/security/csrf";

/**
 * Shared request guard for the local REST API surface.
 *
 * The loopback / Origin / Referer / Content-Type enforcement now lives in
 * `src/lib/security/csrf.ts` so it can be applied centrally (see `src/proxy.ts`)
 * as well as per-route. This module re-exports the primitives and layers the
 * `requireJsonBody` option the projects/system routes need.
 */

export { isLoopbackHostname, isLocalRequest };

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
  return validateCsrf(req, options);
}
