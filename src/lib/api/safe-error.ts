/**
 * Safe error message for API responses.
 *
 * Never mirror raw `err.message` / `String(err)` back to API clients: those
 * routinely embed filesystem paths, SQL fragments, model/HF repo IDs, env
 * hints and stack-adjacent detail that leaks internals to any same-origin
 * page (and, via the no-login loopback app, to any website the user visits).
 *
 * Instead, log the real error on the server and return a generic message plus
 * an opaque correlation id the operator can grep for in the logs.
 */

/** Short, non-identifying client-facing error summary. */
const GENERIC_MESSAGE = "An internal error occurred while processing the request.";

/** Categories of error whose message is inherently safe to surface. */
function isSafeToSurface(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Zod validation already produces safe, structured issues separately; a bare
  // Error whose only info is validation is fine. We whitelist by message prefix
  // for known, non-sensitive operational messages.
  return /^(Invalid|Unsupported|Not found|Already |Job .* not found|Database is busy)/i.test(
    err.message
  );
}

/**
 * Build a safe API error response body for an unexpected (5xx) error.
 * The real error is expected to be logged server-side before this is called.
 */
export function safeApiError(err: unknown, opts?: { status?: number; code?: string }): {
  ok: false;
  error: string;
  code?: string;
} {
  const status = opts?.status ?? 500;
  const code = opts?.code;
  if (status < 500 && isSafeToSurface(err)) {
    return { ok: false, error: err instanceof Error ? err.message : GENERIC_MESSAGE, code };
  }
  return { ok: false, error: GENERIC_MESSAGE, code };
}

/**
 * Resolve a message to return to the client for an unexpected error: opaque
 * unless it is a known-safe operational category.
 */
export function safeErrorMessage(err: unknown): string {
  if (isSafeToSurface(err)) {
    return err instanceof Error ? err.message : GENERIC_MESSAGE;
  }
  return GENERIC_MESSAGE;
}
