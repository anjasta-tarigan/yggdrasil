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

export interface ValidateWebProviderRequestOptions {
  requireJsonBody?: boolean;
  isCredentialCheck?: boolean;
  credentialKey?: string;
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

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/**
 * True when the request reached the server over the local loopback interface.
 * Inspects proxy/forwarded headers to prevent client-controlled Host header bypasses.
 */
export function isLocalRequest(req: Request): boolean {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop && !isLoopbackHostname(firstHop)) {
      return false;
    }
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && !isLoopbackHostname(realIp)) {
    return false;
  }

  const forwarded = req.headers.get("forwarded");
  if (forwarded && /for=/i.test(forwarded)) {
    const value = forwarded.split(",")[0] ?? "";
    const match = /for="?\[?([^";\]]+)\]?"?/i.exec(value);
    const forHost = match?.[1]?.trim();
    if (forHost && !isLoopbackHostname(forHost)) {
      return false;
    }
  }

  let reqUrlHostname: string | null = null;
  try {
    reqUrlHostname = new URL(req.url).hostname;
  } catch {
    return false;
  }

  if (!isLoopbackHostname(reqUrlHostname)) {
    return false;
  }

  const hostHeader = req.headers.get("host");
  if (hostHeader) {
    try {
      const hostUrl = new URL(hostHeader.includes("://") ? hostHeader : `http://${hostHeader}`);
      if (!isLoopbackHostname(hostUrl.hostname)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
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

export function checkCredentialRateLimit(
  key: string,
  now: number = Date.now()
): RateLimitResult {
  const maxAttempts = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_CREDENTIAL;
  const windowMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS;
  const cooldownMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS;
  return checkRateLimit(`cred:${key}`, maxAttempts, windowMs, cooldownMs, now);
}

export function acquireCheckSlot(
  key: string,
  maxConcurrent: number = env.YGGDRASIL_WEB_PROVIDER_CHECK_MAX_CONCURRENT
): boolean {
  const current = activeChecks.get(key) ?? 0;
  if (current >= maxConcurrent) {
    return false;
  }
  activeChecks.set(key, current + 1);
  return true;
}

export function releaseCheckSlot(key: string): void {
  const current = activeChecks.get(key) ?? 0;
  if (current <= 1) {
    activeChecks.delete(key);
  } else {
    activeChecks.set(key, current - 1);
  }
}

export function getActiveCheckCount(key: string): number {
  return activeChecks.get(key) ?? 0;
}

export function getClientIpKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const clientIp = forwarded ? forwarded.split(",")[0]?.trim() : "local-ip";
  return `ip:${clientIp || "local-ip"}`;
}

export async function readJsonBodyWithLimit<T = unknown>(
  req: Request,
  maxBytes: number = env.YGGDRASIL_WEB_PROVIDER_MAX_BODY_BYTES
): Promise<{ ok: true; data: T } | { ok: false; response: NextResponse }> {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, code: "invalid_request", message: "Failed to read request body" },
        { status: 400 }
      ),
    };
  }

  if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          ok: false,
          code: "invalid_request",
          message: `Request body exceeds maximum allowed size of ${maxBytes} bytes`,
        },
        { status: 413 }
      ),
    };
  }

  try {
    const data = JSON.parse(rawBody) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, code: "invalid_request", message: "Invalid JSON body" },
        { status: 400 }
      ),
    };
  }
}

export function validateWebProviderRequest(
  req: Request,
  options?: ValidateWebProviderRequestOptions
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
  const isLocal = isLocalRequest(req);
  const secret = process.env.APP_SECRET || env.APP_SECRET;
  let isAuthorizedRemote = false;

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!secret || !timingSafeEqualStr(token, secret)) {
      return NextResponse.json({ ok: false, code: "invalid_request", message: "Unauthorized" }, { status: 401 });
    }
    isAuthorizedRemote = true;
  } else if (!isLocal) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Unauthorized: APP_SECRET required for remote access" },
      { status: 401 }
    );
  }

  // 2. CSRF / Origin / Referer validation on mutating requests
  // Bypassed for verified Bearer APP_SECRET (non-browser remote management)
  if (isMutating && !isAuthorizedRemote) {
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
  }

  // 3. Content-Length & Content-Type check on mutating requests
  if (isMutating) {
    const contentLengthHeader = req.headers.get("content-length");
    if (contentLengthHeader) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > env.YGGDRASIL_WEB_PROVIDER_MAX_BODY_BYTES) {
        return NextResponse.json(
          {
            ok: false,
            code: "invalid_request",
            message: `Request body exceeds maximum allowed size of ${env.YGGDRASIL_WEB_PROVIDER_MAX_BODY_BYTES} bytes`,
          },
          { status: 413 }
        );
      }
    }

    const contentType = req.headers.get("content-type");
    const expectsBody = options?.requireJsonBody ?? (method === "POST" || method === "PATCH" || method === "PUT");

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

  // 4. Rate limiting & concurrency for credential validation (Spec §6.1)
  if (options?.isCredentialCheck) {
    const fallbackRetryAfter = String(env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS);
    const ipKey = getClientIpKey(req);

    // Concurrency limit check: IP slot
    const ipConcurrent = activeChecks.get(ipKey) ?? 0;
    if (ipConcurrent >= env.YGGDRASIL_WEB_PROVIDER_CHECK_MAX_CONCURRENT) {
      return NextResponse.json(
        { ok: false, code: "rate_limited", message: "Too many concurrent checks. Try again later." },
        { status: 429, headers: { "Retry-After": fallbackRetryAfter } }
      );
    }

    // Concurrency limit check: Credential slot (if credentialKey provided)
    if (options.credentialKey) {
      const credKey = `cred:${options.credentialKey}`;
      const credConcurrent = activeChecks.get(credKey) ?? 0;
      if (credConcurrent >= env.YGGDRASIL_WEB_PROVIDER_CHECK_MAX_CONCURRENT) {
        return NextResponse.json(
          { ok: false, code: "rate_limited", message: "Too many concurrent checks for this credential. Try again later." },
          { status: 429, headers: { "Retry-After": fallbackRetryAfter } }
        );
      }
    }

    // Rate limit check: IP
    const windowMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS;
    const cooldownMs = env.YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS;
    const maxAttemptsIp = env.YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_IP;

    const ipRateResult = checkRateLimit(ipKey, maxAttemptsIp, windowMs, cooldownMs);
    if (!ipRateResult.allowed) {
      return NextResponse.json(
        { ok: false, code: "rate_limited", message: "Too many attempts. Try again after the cooldown." },
        {
          status: 429,
          headers: {
            "Retry-After": String(ipRateResult.retryAfterSeconds ?? fallbackRetryAfter),
          },
        }
      );
    }

    // Rate limit check: Credential (if credentialKey provided)
    if (options.credentialKey) {
      const credRateResult = checkCredentialRateLimit(options.credentialKey);
      if (!credRateResult.allowed) {
        return NextResponse.json(
          { ok: false, code: "rate_limited", message: "Too many attempts for this credential. Try again after the cooldown." },
          {
            status: 429,
            headers: {
              "Retry-After": String(credRateResult.retryAfterSeconds ?? fallbackRetryAfter),
            },
          }
        );
      }
    }
  }

  return null;
}
