import { NextResponse } from "next/server";
import { env } from "@/env";
import { timingSafeEqual } from "node:crypto";

interface RateLimitBucket {
  attempts: number[];
  blockedUntil?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

const rateLimitMap = new Map<string, RateLimitBucket>();
const activeChecks = new Map<string, number>();
const MAX_RATE_LIMIT_ENTRIES = 10_000;

export function resetRateLimiterForTest(): void {
  rateLimitMap.clear();
  activeChecks.clear();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isLoopbackHost(hostStr: string): boolean {
  try {
    const url = new URL(hostStr.includes("://") ? hostStr : `http://${hostStr}`);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowMs: number,
  cooldownMs: number,
  now: number = Date.now()
): RateLimitResult {
  const maxRetryAfter = env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS;

  // Prune map size if threshold exceeded (Rule 02 bounded memory)
  if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
    for (const [k, b] of rateLimitMap.entries()) {
      if ((!b.blockedUntil || b.blockedUntil <= now) && b.attempts.every((t) => now - t >= windowMs)) {
        rateLimitMap.delete(k);
      }
    }
  }

  const bucket = rateLimitMap.get(key) ?? { attempts: [] };

  if (bucket.blockedUntil && bucket.blockedUntil > now) {
    const retryAfterSeconds = Math.ceil((bucket.blockedUntil - now) / 1000);
    return {
      allowed: false,
      retryAfterSeconds: Math.min(retryAfterSeconds, maxRetryAfter),
    };
  }

  // Prune attempts older than window
  bucket.attempts = bucket.attempts.filter((ts) => now - ts < windowMs);

  if (bucket.attempts.length >= maxAttempts) {
    bucket.blockedUntil = now + cooldownMs;
    rateLimitMap.set(key, bucket);
    const retryAfterSeconds = Math.ceil(cooldownMs / 1000);
    return {
      allowed: false,
      retryAfterSeconds: Math.min(retryAfterSeconds, maxRetryAfter),
    };
  }

  bucket.attempts.push(now);
  rateLimitMap.set(key, bucket);
  return { allowed: true };
}

export function validateWebProviderRequest(
  req: Request,
  options?: { requireJsonBody?: boolean; isCredentialCheck?: boolean }
): NextResponse | null {
  if (!env.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS && process.env.NODE_ENV !== "test") {
    return NextResponse.json(
      { ok: false, code: "feature_disabled", message: "Experimental Web Providers are currently disabled." },
      { status: 404 }
    );
  }

  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PATCH", "DELETE", "PUT"].includes(method);

  // 1. Authenticate caller (loopback or Bearer APP_SECRET)
  const authHeader = req.headers.get("authorization");
  const host = req.headers.get("host") || new URL(req.url).host;
  const isLocalHost = isLoopbackHost(host);
  const secret = process.env.APP_SECRET || env.APP_SECRET;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!secret || !timingSafeEqualStr(token, secret)) {
      return NextResponse.json({ ok: false, code: "invalid_request", message: "Unauthorized" }, { status: 401 });
    }
  } else if (!isLocalHost) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Unauthorized: APP_SECRET required for remote access" },
      { status: 401 }
    );
  }

  // 2. CSRF / Origin / Referer validation on mutating requests
  if (isMutating) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");

    // Spec §6.1: Origin is required; if absent, Referer is required; missing or mismatched is rejected
    let checkHeader: string | null = origin;
    if (!checkHeader && referer) {
      try {
        checkHeader = new URL(referer).origin;
      } catch {
        return NextResponse.json(
          { ok: false, code: "invalid_request", message: "Forbidden: invalid Origin or Referer" },
          { status: 403 }
        );
      }
    }

    if (!checkHeader) {
      return NextResponse.json(
        { ok: false, code: "invalid_request", message: "Forbidden: Origin or Referer header required" },
        { status: 403 }
      );
    }

    try {
      const headerUrl = new URL(checkHeader);
      const reqUrl = new URL(req.url);
      const hostHeader = req.headers.get("host");
      const hostMatches = headerUrl.host === reqUrl.host || (hostHeader && headerUrl.host === hostHeader);
      if (!hostMatches) {
        return NextResponse.json(
          { ok: false, code: "invalid_request", message: "Forbidden: cross-origin mutation rejected" },
          { status: 403 }
        );
      }
    } catch {
      return NextResponse.json(
        { ok: false, code: "invalid_request", message: "Forbidden: invalid Origin or Referer" },
        { status: 403 }
      );
    }

    // 3. Content-Type check
    const contentType = req.headers.get("content-type");
    const expectsBody = options?.requireJsonBody ?? (method === "POST" || method === "PATCH");

    if (expectsBody) {
      if (!contentType || !contentType.toLowerCase().includes("application/json")) {
        return NextResponse.json(
          { ok: false, code: "invalid_request", message: "Content-Type must be application/json" },
          { status: 415 }
        );
      }
    } else if (contentType && !contentType.toLowerCase().includes("application/json")) {
      return NextResponse.json(
        { ok: false, code: "invalid_request", message: "Content-Type must be application/json" },
        { status: 415 }
      );
    }
  }

  // 4. Rate limiting for credential validation (Spec §6.1)
  if (options?.isCredentialCheck) {
    const clientKey = req.headers.get("x-forwarded-for") || "local-ip";
    const windowMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS;
    const cooldownMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS;
    const maxAttempts = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_IP;

    const rateResult = checkRateLimit(clientKey, maxAttempts, windowMs, cooldownMs);
    if (!rateResult.allowed) {
      return NextResponse.json(
        { ok: false, code: "rate_limited", message: "Too many attempts. Try again after the cooldown." },
        { status: 429, headers: { "Retry-After": String(rateResult.retryAfterSeconds ?? 60) } }
      );
    }
  }

  return null;
}
