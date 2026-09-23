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

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, { isCredentialCheck: true });
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
    await store.updateStatus("deepseek-web", "verified");
    return NextResponse.json({ ok: true, provider: "deepseek-web", status: "verified" });
  } finally {
    releaseCheckSlot(credSlotKey);
    releaseCheckSlot(ipKey);
  }
}
