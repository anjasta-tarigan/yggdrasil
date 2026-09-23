import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { env } from "@/env";
import {
  validateWebProviderRequest,
  getClientIpKey,
  acquireCheckSlot,
  releaseCheckSlot,
  checkCredentialRateLimit,
  readJsonBodyWithLimit,
} from "../../guard";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";
import { parseSessionCandidate } from "@/lib/ai/web-provider/adapter";
import { DeepSeekWebAdapter } from "@/lib/ai/web-provider/deepseek";
import { failureResponse } from "../../error-response";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, { requireJsonBody: true, isCredentialCheck: true });
  if (guardRes) return guardRes;

  const bodyResult = await readJsonBodyWithLimit(req);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const parseResult = parseSessionCandidate(bodyResult.data);
  if (!parseResult.ok) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: parseResult.error }, { status: 400 });
  }

  const credKey = createHash("sha256").update(parseResult.data.userToken).digest("hex");
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
    // Server-side revalidation before persistence (Spec §5.3, §6.4): the client
    // cannot submit a "verified" assertion, and a failed check leaves all prior
    // state unchanged.
    const adapter = new DeepSeekWebAdapter();
    const validation = await adapter.validateSession({
      userToken: parseResult.data.userToken,
      userAgentMode: parseResult.data.userAgentMode,
      selectedUserAgent: parseResult.data.userAgent,
    });

    if (!validation.ok) {
      return failureResponse(validation);
    }

    try {
      // `createSessionStore` throws when APP_SECRET is missing or too short; it
      // belongs inside the try so the failure stays a sanitized 500 rather than
      // escaping as an unhandled error.
      const store = createSessionStore();
      await store.saveSession({
        providerId: "deepseek-web",
        userToken: parseResult.data.userToken,
        userAgentMode: parseResult.data.userAgentMode,
        selectedUserAgent: parseResult.data.userAgent,
      });
    } catch {
      return NextResponse.json(
        { ok: false, code: "protocol_error", message: "Failed to store web provider session" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      provider: "deepseek-web",
      status: "verified",
      lastCheckedAt: new Date().toISOString(),
    });
  } finally {
    releaseCheckSlot(credSlotKey);
    releaseCheckSlot(ipKey);
  }
}

export async function DELETE(req: Request) {
  const guardRes = validateWebProviderRequest(req);
  if (guardRes) return guardRes;

  try {
    const store = createSessionStore();
    await store.deleteSession("deepseek-web");
    return NextResponse.json({ ok: true, provider: "deepseek-web", status: "not-configured" });
  } catch {
    return NextResponse.json(
      { ok: false, code: "protocol_error", message: "Failed to delete web provider session" },
      { status: 500 }
    );
  }
}
