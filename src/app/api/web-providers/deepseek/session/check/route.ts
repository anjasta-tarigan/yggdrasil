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
} from "../../../guard";
import { parseSessionCandidate } from "@/lib/ai/web-provider/adapter";

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
    // Side-effect-free check (MVP mock / stub verification before Task 7 adapter integration)
    return NextResponse.json({ ok: true, provider: "deepseek-web", status: "verified" });
  } finally {
    releaseCheckSlot(credSlotKey);
    releaseCheckSlot(ipKey);
  }
}
