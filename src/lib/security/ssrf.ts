/**
 * SSRF Defense & Secure URL Fetching Module.
 *
 * Conforms strictly to Rule 04 (§1.10 SSRF Prevention):
 * - Validates URL protocols (http: and https: only).
 * - Resolves DNS and blocks private/loopback/cloud metadata IP ranges:
 *   - Loopback: 127.0.0.0/8, ::1, localhost
 *   - Cloud Metadata: 169.254.169.254, metadata.google.internal, etc.
 *   - Private IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 0.0.0.0/8, 100.64.0.0/10
 *   - Private IPv6: fc00::/7 (ULA), fe80::/10 (Link-Local), ::/128, ff00::/8
 *   - IPv4-mapped IPv6 ranges.
 * - Re-validates target IP on redirects (manual redirect inspection).
 * - Enforces 10MB response ceiling and 10s default timeout.
 */

import dns from "node:dns/promises";
import net from "node:net";

export const DEFAULT_SSRF_MAX_BYTES = 10 * 1024 * 1024; // 10MB
export const DEFAULT_SSRF_TIMEOUT_MS = 10_000; // 10s
export const MAX_REDIRECTS = 5;

export class SSRFError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "SSRFError";
  }
}

export interface SecureFetchOptions extends RequestInit {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Custom fetch implementation (useful for tests) */
  fetchImpl?: typeof fetch;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".lan",
  ".home",
  ".corp",
];

/**
 * Parses an IPv4 string in strict dotted-decimal format into 4 octets.
 */
function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255 || (part.length > 1 && part.startsWith("0"))) {
      // Disallow octal or out-of-bounds numbers
      return null;
    }
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

/**
 * Checks if IPv4 octets fall into private, loopback, link-local, or reserved ranges.
 */
function isPrivateIPv4(nums: [number, number, number, number]): boolean {
  const [a, b, c] = nums;
  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC 1918 private)
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-Grade NAT / Shared Address Space)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-Local / Cloud Metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC 1918 private: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.88.99.0/24 (6to4 Relay Anycast)
  if (a === 192 && b === 88 && c === 99) return true;
  // 192.168.0.0/16 (RFC 1918 private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Network Benchmark Tests: 198.18.0.0 - 198.19.255.255)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast 224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved / Broadcast: 240.0.0.0 - 255.255.255.255)
  if (a >= 240) return true;
  return false;
}

/**
 * Parses an IPv6 string into 8 16-bit integers.
 */
function parseIPv6(ip: string): number[] | null {
  let clean = ip.toLowerCase();
  const zoneIndex = clean.indexOf("%");
  if (zoneIndex !== -1) {
    clean = clean.slice(0, zoneIndex);
  }

  // Handle embedded IPv4 notation (e.g. ::ffff:192.168.1.1)
  const lastColon = clean.lastIndexOf(":");
  if (lastColon !== -1) {
    const tail = clean.slice(lastColon + 1);
    if (tail.includes(".")) {
      const v4 = parseIPv4(tail);
      if (!v4) return null;
      const word1 = ((v4[0] << 8) | v4[1]).toString(16);
      const word2 = ((v4[2] << 8) | v4[3]).toString(16);
      clean = `${clean.slice(0, lastColon)}:${word1}:${word2}`;
    }
  }

  const doubleColonCount = (clean.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  if (doubleColonCount === 1) {
    const [leftStr, rightStr] = clean.split("::");
    const leftWords = leftStr ? leftStr.split(":") : [];
    const rightWords = rightStr ? rightStr.split(":") : [];
    const totalWords = leftWords.length + rightWords.length;
    if (totalWords > 7) return null;
    const fillCount = 8 - totalWords;
    const fill = new Array(fillCount).fill("0");
    const allWords = [...leftWords, ...fill, ...rightWords];
    const parsed = allWords.map((w) => parseInt(w || "0", 16));
    if (parsed.some((n) => isNaN(n) || n < 0 || n > 0xffff)) return null;
    return parsed;
  } else {
    const words = clean.split(":");
    if (words.length !== 8) return null;
    const parsed = words.map((w) => parseInt(w, 16));
    if (parsed.some((n) => isNaN(n) || n < 0 || n > 0xffff)) return null;
    return parsed;
  }
}

/**
 * Checks if IPv6 words fall into private, loopback, ULA, link-local, or multicast ranges.
 */
function isPrivateIPv6(words: number[]): boolean {
  // ::/128 (Unspecified)
  if (words.every((w) => w === 0)) return true;

  // ::1/128 (Loopback)
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

  // ::ffff:0:0/96 (IPv4-mapped IPv6)
  if (
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const a = (words[6] >> 8) & 0xff;
    const b = words[6] & 0xff;
    const c = (words[7] >> 8) & 0xff;
    const d = words[7] & 0xff;
    return isPrivateIPv4([a, b, c, d]);
  }

  // 64:ff9b::/96 (NAT64 prefix)
  if (
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0
  ) {
    const a = (words[6] >> 8) & 0xff;
    const b = words[6] & 0xff;
    const c = (words[7] >> 8) & 0xff;
    const d = words[7] & 0xff;
    return isPrivateIPv4([a, b, c, d]);
  }

  // 100::/64 (Discard Prefix - RFC 6666)
  if (words[0] === 0x100 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
    return true;
  }

  // 2001:db8::/32 (Documentation)
  if (words[0] === 0x2001 && words[1] === 0xdb8) {
    return true;
  }

  // fc00::/7 (Unique Local Address - ULA: fc00:: to fdff::)
  if ((words[0] & 0xfe00) === 0xfc00) {
    return true;
  }

  // fe80::/10 (Link-Local Unicast: fe80:: to febf::)
  if ((words[0] & 0xffc0) === 0xfe80) {
    return true;
  }

  // ff00::/8 (Multicast)
  if ((words[0] & 0xff00) === 0xff00) {
    return true;
  }

  return false;
}

/**
 * Validates whether an IP address (IPv4 or IPv6) is private, loopback, or blocked.
 * Returns true if the IP is blocked / private, false if it is safe / public.
 */
export function isPrivateOrBlockedIP(ip: string): boolean {
  if (!ip || typeof ip !== "string") return true;
  const clean = ip.trim().replace(/^\[|\]$/g, "");
  if (!clean) return true;

  const family = net.isIP(clean);
  if (family === 4) {
    const v4 = parseIPv4(clean);
    if (!v4) return true;
    return isPrivateIPv4(v4);
  }

  if (family === 6) {
    const v6 = parseIPv6(clean);
    if (!v6) return true;
    return isPrivateIPv6(v6);
  }

  // Not a valid IP -> block by default for safety
  return true;
}

/**
 * Asserts that a URL string uses a safe protocol (http/https), does not point to
 * localhost / cloud metadata, and does not resolve via DNS to a private or blocked IP.
 * Returns the parsed safe URL object.
 */
export async function assertSafeUrl(urlStr: string): Promise<URL> {
  if (!urlStr || typeof urlStr !== "string") {
    throw new SSRFError(`Invalid URL: ${urlStr}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new SSRFError(`Invalid URL: ${urlStr}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SSRFError(
      `Only HTTP and HTTPS protocols are allowed (got ${parsed.protocol})`
    );
  }

  const hostname = parsed.hostname.toLowerCase().trim();
  if (!hostname) {
    throw new SSRFError("URL hostname cannot be empty");
  }

  // Check known blocked hostnames and suffixes
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new SSRFError(`Blocked hostname or IP: ${hostname}`);
  }

  const cleanHost = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(cleanHost)) {
    if (isPrivateOrBlockedIP(cleanHost)) {
      throw new SSRFError(`Blocked hostname or IP: ${hostname}`);
    }
  } else {
    // Resolve DNS records
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (!addresses || addresses.length === 0) {
        throw new SSRFError(`Could not resolve hostname: ${hostname}`);
      }
      for (const record of addresses) {
        if (isPrivateOrBlockedIP(record.address)) {
          throw new SSRFError(
            `Hostname "${hostname}" resolves to a blocked IP: ${record.address}`
          );
        }
      }
    } catch (err) {
      if (err instanceof SSRFError) throw err;
      throw new SSRFError(
        `DNS resolution failed for hostname "${hostname}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return parsed;
}

/**
 * Wraps a response's body stream with a strict byte counter that halts and throws
 * if the received content exceeds maxBytes.
 */
function createSizeLimitedResponse(
  response: Response,
  maxBytes: number
): Response {
  if (!response.body) {
    return response;
  }

  let bytesRead = 0;
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBytes) {
        controller.error(
          new SSRFError(
            `Response exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit`
          )
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  const limitedBody = response.body.pipeThrough(transform);
  return new Response(limitedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Securely fetches a URL with SSRF defense:
 * - Validates host and DNS resolution against private / blocked IP lists.
 * - Inspects and re-validates redirect targets manually.
 * - Enforces a 10MB response size ceiling.
 * - Enforces a 10s default timeout with AbortSignal.
 */
export async function secureFetch(
  urlStr: string,
  options: SecureFetchOptions = {}
): Promise<Response> {
  const maxBytes = options.maxBytes ?? DEFAULT_SSRF_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSRF_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  let currentUrlStr = urlStr;
  let redirectCount = 0;
  // Method/body carried into the NEXT hop. RFC 9110: 301/302/303 downgrade
  // to GET and drop the body (only 307/308 preserve method and payload) —
  // never re-POST a body cross-host just because the target redirected.
  let nextMethod: string | undefined;
  let nextBody: BodyInit | undefined;

  while (true) {
    const safeUrl = await assertSafeUrl(currentUrlStr);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let abortListener: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw (
          options.signal.reason ??
          new DOMException("The operation was aborted.", "AbortError")
        );
      }
      abortListener = () => controller.abort(options.signal?.reason);
      options.signal.addEventListener("abort", abortListener, { once: true });
    }

    let response: Response;
    try {
      const { signal: _callerSignal, fetchImpl: _impl, ...fetchOptions } = options;
      response = await fetchImpl(safeUrl.toString(), {
        ...fetchOptions,
        ...(nextMethod !== undefined ? { method: nextMethod } : {}),
        ...(nextBody !== undefined ? { body: nextBody } : {}),
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new SSRFError(
          `Request to ${safeUrl.hostname} timed out after ${timeoutMs}ms`
        );
      }
      if (err instanceof SSRFError) {
        throw err;
      }
      throw new SSRFError(
        `Request to ${safeUrl.hostname} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
      if (abortListener && options.signal) {
        options.signal.removeEventListener("abort", abortListener);
      }
    }

    // Handle manual redirects
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return createSizeLimitedResponse(response, maxBytes);
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new SSRFError(`Too many redirects (max ${maxRedirects})`);
      }

      const targetUrl = new URL(location, safeUrl);
      currentUrlStr = targetUrl.toString();

      // RFC 9110 §15.4: 303 always, and 301/302 historically, downgrade to
      // GET and discard the request body; 307/308 preserve both.
      if (response.status !== 307 && response.status !== 308) {
        nextMethod = "GET";
        nextBody = undefined;
      } else {
        nextMethod = options.method ?? "GET";
        nextBody = options.body ?? undefined;
      }
      continue;
    }

    // Check Content-Length header if present
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const parsedLength = parseInt(contentLength, 10);
      if (!isNaN(parsedLength) && parsedLength > maxBytes) {
        throw new SSRFError(
          `Response exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit (${parsedLength} bytes)`
        );
      }
    }

    return createSizeLimitedResponse(response, maxBytes);
  }
}
