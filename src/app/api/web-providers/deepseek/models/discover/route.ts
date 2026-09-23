import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";
import {
  acquireCheckSlot,
  checkCredentialRateLimit,
  getClientIpKey,
  readJsonBodyWithLimit,
  releaseCheckSlot,
  validateWebProviderRequest,
} from "../../../guard";
import { failureResponse } from "../../../error-response";
import { createSessionStore } from "@/lib/ai/web-provider/session-store";
import {
  DEEPSEEK_WEB_PROVIDER_ID,
  discoverAndMergeModels,
} from "@/lib/ai/web-provider/discovery";
import type { AdapterFailure } from "@/lib/ai/web-provider/deepseek";

export const dynamic = "force-dynamic";

/**
 * Strict body contract (Spec §6.6): the client may ask for a refresh, nothing
 * more. Unknown fields are rejected rather than ignored, so a client cannot
 * smuggle a token, endpoint, or User-Agent through discovery.
 */
const DiscoverBodySchema = z.object({ force: z.boolean().optional() }).strict();

const SESSION_REJECTED: AdapterFailure = {
  ok: false,
  code: "session_rejected",
  httpStatus: 401,
  message: "Session is not configured or verified",
};

export async function POST(req: Request) {
  const guardRes = validateWebProviderRequest(req, {
    requireJsonBody: true,
    isCredentialCheck: true,
  });
  if (guardRes) return guardRes;

  const bodyResult = await readJsonBodyWithLimit(req);
  if (!bodyResult.ok) return bodyResult.response;

  const parsedBody = DiscoverBodySchema.safeParse(bodyResult.data);
  if (!parsedBody.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Expected { force?: boolean }" },
      { status: 400 }
    );
  }
  const force = parsedBody.data.force === true;

  let session;
  try {
    // `createSessionStore` throws when APP_SECRET is missing or too short; it
    // belongs inside the try so the failure stays a sanitized 500.
    session = await createSessionStore().getSession(DEEPSEEK_WEB_PROVIDER_ID);
  } catch {
    return NextResponse.json(
      { ok: false, code: "protocol_error", message: "Web provider session store is unavailable" },
      { status: 500 }
    );
  }

  // Discovery runs against the saved server-side session only; the request
  // never carries the token, cookies, endpoint, or User-Agent (Spec §6.6).
  if (!session || session.status !== "verified") {
    return failureResponse(SESSION_REJECTED);
  }

  const credentialKey = createHash("sha256").update(session.userToken).digest("hex");
  const credRateResult = checkCredentialRateLimit(credentialKey);
  if (!credRateResult.allowed) {
    const fallbackRetryAfter = String(env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS);
    return NextResponse.json(
      { ok: false, code: "rate_limited", message: "Too many discovery attempts. Try again after the cooldown." },
      {
        status: 429,
        headers: { "Retry-After": String(credRateResult.retryAfterSeconds ?? fallbackRetryAfter) },
      }
    );
  }

  const ipKey = getClientIpKey(req);
  const credSlotKey = `cred:${credentialKey}`;

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
    const result = await discoverAndMergeModels(session, {
      force,
      // Bounds the whole management request, including the adapter's own retry
      // budget (Spec §11.2 route deadline).
      signal: AbortSignal.timeout(env.YGGDRASIL_WEB_PROVIDER_ROUTE_TIMEOUT_MS),
    });

    if (!result.ok) return failureResponse(result);

    return NextResponse.json({
      ok: true,
      provider: DEEPSEEK_WEB_PROVIDER_ID,
      models: result.models,
      cache: result.cache,
    });
  } finally {
    releaseCheckSlot(credSlotKey);
    releaseCheckSlot(ipKey);
  }
}
