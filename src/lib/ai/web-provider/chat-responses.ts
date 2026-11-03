import { env, refreshEnv } from "@/env";
import { ERROR_MAPPING } from "./adapter";
import type { WebProviderSession } from "./types";

/**
 * Spec §11.2/§14.5/§15.18 — the operator kill switch. Reuses the adapter's
 * closed error mapping so the chat path, the management routes, and the
 * adapter cannot drift on the status/message an operator sees.
 */
const WEB_SESSION_FEATURE_DISABLED = ERROR_MAPPING.feature_disabled;

/** Spec §6/§10 — a missing or non-verified session is an actionable 401. */
const WEB_SESSION_REQUIRED_MESSAGE =
  "DeepSeek Web session expired or was rejected. Re-import the session token to continue.";

/**
 * Spec §8.5 — a verified session whose model data is older than the stale
 * window is unusable, but the fix is a model refresh, not a token re-import,
 * so it gets its own actionable message rather than the credential one.
 */
const WEB_SESSION_STALE_MESSAGE =
  "DeepSeek Web model data is stale. Refresh the discovered models in Settings → Providers to continue.";

/**
 * True when the session's discovered model data has aged past the 24h stale
 * window (Spec §8.5). `lastCheckedAt` is the last successful revalidation;
 * `capturedAt` is the import time, used before the first revalidation. A
 * session with neither has no freshness evidence and is treated as stale.
 */
export function isWebSessionStale(session: WebProviderSession): boolean {
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  const lastActive = session.lastCheckedAt?.getTime() ?? session.capturedAt?.getTime() ?? 0;
  return Date.now() - lastActive > currentEnv.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS;
}

/**
 * Reads the flag through `refreshEnv()` under test so a suite can flip it
 * (`vi.stubEnv`) without re-importing this module — the pattern established by
 * `src/app/api/projects/guard.ts` and `src/lib/security/ssrf.ts`.
 */
export function webSessionFeatureDisabledResponse(): Response | null {
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  if (currentEnv.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS) return null;
  return new Response(WEB_SESSION_FEATURE_DISABLED.message, {
    status: WEB_SESSION_FEATURE_DISABLED.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function webSessionRequiredResponse(): Response {
  return new Response(WEB_SESSION_REQUIRED_MESSAGE, {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function webSessionStaleResponse(): Response {
  return new Response(WEB_SESSION_STALE_MESSAGE, {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
