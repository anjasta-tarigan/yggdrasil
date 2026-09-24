import { env } from "@/env";
import { syslog, type LogLevel } from "@/lib/observability/log-store";
import { updateWebSessionStatus } from "./session-store";
import type { AdapterErrorCode } from "./adapter";

/**
 * Protocol-failure circuit breaker (Spec §11.3).
 *
 * Three protocol parse failures for one provider within the configured window
 * disable it: the session status is set so the chat gate refuses it, and the
 * operator gets one actionable warning. Only `protocol_error` and
 * `unsupported_protocol` count — a rejected credential, a rate limit, or a
 * transient network fault says nothing about the adapter's protocol support,
 * so those must never trip it.
 *
 * The failure record is in-process and keyed by provider id (the adapter
 * version is a build-time constant, so it cannot vary within one process). The
 * bucket is pruned on every call so it cannot grow without bound, and a tripped
 * provider stays tripped until `resetProtocolFailures` — the recovery path is a
 * session re-import, which clears it.
 */

interface FailureEntry {
  timestamp: number;
  code: AdapterErrorCode;
}

const failureBuckets = new Map<string, FailureEntry[]>();
/** Providers already disabled, so a repeated failure never re-logs or re-writes. */
const tripped = new Set<string>();

/** A protocol failure is the only signal that the adapter cannot parse the upstream. */
function countsTowardTrip(code: AdapterErrorCode): boolean {
  return code === "protocol_error" || code === "unsupported_protocol";
}

/**
 * Records one protocol failure and disables the provider once the windowed
 * count reaches the threshold. Idempotent once tripped.
 */
export async function recordProtocolFailure(providerId: string, code: AdapterErrorCode): Promise<void> {
  if (!countsTowardTrip(code)) return;
  if (tripped.has(providerId)) return;

  const now = Date.now();
  const windowMs = env.YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_WINDOW_MS;
  const cutoff = now - windowMs;
  const window = (failureBuckets.get(providerId) ?? []).filter((entry) => entry.timestamp > cutoff);
  window.push({ timestamp: now, code });

  if (window.length < env.YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_THRESHOLD) {
    failureBuckets.set(providerId, window);
    return;
  }

  // Claim the trip before the await: two interleaved failures that both reach
  // the threshold would otherwise both pass the `tripped.has` check and both
  // write and log (Rule 17). The bucket is dropped with the claim so a
  // post-reset count starts fresh.
  tripped.add(providerId);
  failureBuckets.delete(providerId);

  // An unsupported-protocol failure means this adapter version cannot speak
  // the upstream at all; a parse failure is recoverable and leaves the session
  // degraded (Spec §7.3).
  const unsupported = window.some((entry) => entry.code === "unsupported_protocol");
  const status = unsupported ? "unsupported" : "degraded";
  const failureCode = unsupported ? "unsupported_protocol" : "protocol_error";

  // Best-effort at this IO boundary: the caller is already handling an upstream
  // protocol failure, so a bookkeeping write that throws must never replace or
  // swallow that original error. The claim is released so a later failure can
  // retry the disablement, and the failure is logged, not silently dropped
  // (Rule 02).
  try {
    await updateWebSessionStatus(providerId, status, failureCode);
  } catch {
    tripped.delete(providerId);
    logRequestFailed(providerId, failureCode, "error");
    return;
  }

  logRequestFailed(providerId, failureCode, "warn");
}

/**
 * Spec §12's closed observability surface: the allowed event with only
 * `providerId` and a closed adapter `resultCode`. No status, window count,
 * token, header, or upstream body may appear.
 */
function logRequestFailed(providerId: string, resultCode: AdapterErrorCode, level: LogLevel): void {
  syslog(
    level,
    "web-provider",
    `web_provider.request.failed providerId=${providerId} resultCode=${resultCode}`
  );
}

/** Clears the failure history and the tripped state so counting starts fresh. */
export function resetProtocolFailures(providerId: string): void {
  failureBuckets.delete(providerId);
  tripped.delete(providerId);
}
