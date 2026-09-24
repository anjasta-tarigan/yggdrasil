import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { env } from "@/env";
import {
  validateWebProviderRequest,
  getClientIpKey,
  acquireCheckSlot,
  releaseCheckSlot,
  checkCredentialRateLimit,
} from "../../../guard";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";
import { resetProtocolFailures } from "@/lib/ai/web-provider/circuit-breaker";
import { DeepSeekWebAdapter } from "@/lib/ai/web-provider/deepseek";
import { failureResponse, sessionStatusForFailure } from "../../../error-response";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, { isCredentialCheck: true, requireJsonBody: false });

  if (guardRes) return guardRes;

  const store = createSessionStore();
  const session = await store.getSession("deepseek-web");
  if (!session) {
    return NextResponse.json({ ok: false, code: "session_rejected", message: "No session configured" }, { status: 401 });
  }

  const credKey = createHash("sha256").update(session.userToken).digest("hex");
  const credRateResult = checkCredentialRateLimit(credKey);
  if (!credRateResult.allowed) {
    const fallbackRetryAfter = String(env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS);
    return NextResponse.json(
      { ok: false, code: "rate_limited", message: "Too many attempts for this credential. Try again after the cooldown." },
      { status: 429, headers: { "Retry-After": String(credRateResult.retryAfterSeconds ?? fallbackRetryAfter) } }
    );
  }

  const ipKey = getClientIpKey(req);
  const credSlotKey = `cred:${credKey}`;

  if (!acquireCheckSlot(ipKey)) {
    return NextResponse.json(
      { ok: false, code: "rate_limited", message: "Too many concurrent checks. Try again later." },
      { status: 429, headers: { "Retry-After": String(env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS) } }
    );
  }

  if (!acquireCheckSlot(credSlotKey)) {
    releaseCheckSlot(ipKey);
    return NextResponse.json(
      { ok: false, code: "rate_limited", message: "Too many concurrent checks for this credential. Try again later." },
      { status: 429, headers: { "Retry-After": String(env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS) } }
    );
  }

  try {
    // Re-check the stored credential against the adapter; no new token is
    // obtained and no undocumented cookie is extended (Spec §6.5).
    const adapter = new DeepSeekWebAdapter();
    const validation = await adapter.validateSession({
      userToken: session.userToken,
      userAgentMode: session.userAgentMode ?? "server-default",
      selectedUserAgent: session.selectedUserAgent,
    });

    try {
      // A successful revalidation advances the freshness clock the chat path's
      // 24h stale TTL reads (Spec §8.5); a failed check must not make stale
      // model data look newly discovered. The status write and the freshness
      // touch are separate so a status change alone never moves the clock.
      await store.updateStatus(
        "deepseek-web",
        validation.ok ? "verified" : sessionStatusForFailure(validation.code),
        validation.ok ? null : validation.code
      );
      if (validation.ok) {
        await store.touchSessionCheckedAt("deepseek-web", new Date());
        // Spec §11.3: a successful revalidation proves the adapter still speaks
        // the upstream protocol, so it clears any protocol-failure trip.
        resetProtocolFailures("deepseek-web");
      }
    } catch {
      return NextResponse.json(
        { ok: false, code: "protocol_error", message: "Failed to update web provider session status" },
        { status: 500 }
      );
    }

    if (!validation.ok) {
      return failureResponse(validation);
    }

    return NextResponse.json({ ok: true, provider: "deepseek-web", status: "verified" });
  } finally {
    releaseCheckSlot(credSlotKey);
    releaseCheckSlot(ipKey);
  }
}
