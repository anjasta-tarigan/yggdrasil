import { NextResponse } from "next/server";
import { ERROR_MAPPING, type AdapterErrorCode } from "@/lib/ai/web-provider/adapter";
import type { AdapterFailure } from "@/lib/ai/web-provider/deepseek";
import type { SessionStatus } from "@/lib/ai/web-provider/types";

/**
 * Single source of truth for the management API's closed error surface
 * (Spec §6.3, §15.26). Adapter failures carry a closed code and a sanitized
 * message; this is the only place they become an HTTP response, so raw upstream
 * status text, bodies, headers, and exception messages can never leak.
 */
export function failureResponse(failure: AdapterFailure): NextResponse {
  const mapped = ERROR_MAPPING[failure.code];
  const headers: Record<string, string> = {};
  if (failure.code === "rate_limited" && failure.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(failure.retryAfterSeconds);
  }

  return NextResponse.json({ ok: false, code: failure.code, message: mapped.message }, {
    status: mapped.status,
    headers,
  });
}

/**
 * Maps a closed adapter error code onto the session status persisted for the
 * provider (Spec §7.2, §7.3). Only server operations set this; client input is
 * never trusted.
 */
export function sessionStatusForFailure(code: AdapterErrorCode): SessionStatus {
  switch (code) {
    case "session_rejected":
      return "rejected";
    case "rate_limited":
      return "rate-limited";
    case "unsupported_protocol":
      return "unsupported";
    case "invalid_request":
      return "unsupported";
    default:
      // Timeouts, network failures, and protocol errors leave the session
      // degraded rather than revoked: the credential was never disproved.
      return "degraded";
  }
}
