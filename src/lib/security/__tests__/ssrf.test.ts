import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import dns from "node:dns/promises";
import {
  isPrivateOrBlockedIP,
  assertSafeUrl,
  secureFetch,
  SSRFError,
} from "../ssrf";

describe("SSRF Protection Module", () => {
  describe("isPrivateOrBlockedIP", () => {
    it("identifies IPv4 loopback addresses", () => {
      expect(isPrivateOrBlockedIP("127.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIP("127.0.1.1")).toBe(true);
      expect(isPrivateOrBlockedIP("127.255.255.255")).toBe(true);
    });

    it("identifies IPv6 loopback and unspecified addresses", () => {
      expect(isPrivateOrBlockedIP("::1")).toBe(true);
      expect(isPrivateOrBlockedIP("::")).toBe(true);
      expect(isPrivateOrBlockedIP("0:0:0:0:0:0:0:1")).toBe(true);
      expect(isPrivateOrBlockedIP("0:0:0:0:0:0:0:0")).toBe(true);
    });

    it("identifies cloud metadata endpoints", () => {
      expect(isPrivateOrBlockedIP("169.254.169.254")).toBe(true);
      expect(isPrivateOrBlockedIP("169.254.0.1")).toBe(true);
      expect(isPrivateOrBlockedIP("169.254.255.255")).toBe(true);
    });

    it("identifies IPv4 private intranet ranges (RFC 1918)", () => {
      // 10.0.0.0/8
      expect(isPrivateOrBlockedIP("10.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIP("10.255.255.255")).toBe(true);
      // 172.16.0.0/12
      expect(isPrivateOrBlockedIP("172.16.0.1")).toBe(true);
      expect(isPrivateOrBlockedIP("172.31.255.255")).toBe(true);
      expect(isPrivateOrBlockedIP("172.15.255.255")).toBe(false);
      expect(isPrivateOrBlockedIP("172.32.0.1")).toBe(false);
      // 192.168.0.0/16
      expect(isPrivateOrBlockedIP("192.168.1.1")).toBe(true);
      expect(isPrivateOrBlockedIP("192.168.254.254")).toBe(true);
      // 0.0.0.0/8
      expect(isPrivateOrBlockedIP("0.0.0.0")).toBe(true);
      // 100.64.0.0/10 (Carrier Grade NAT)
      expect(isPrivateOrBlockedIP("100.64.0.1")).toBe(true);
      expect(isPrivateOrBlockedIP("100.127.255.255")).toBe(true);
    });

    it("identifies IPv6 private ranges (ULA and Link-Local)", () => {
      // Unique Local Addresses fc00::/7 (fc00... and fd00...)
      expect(isPrivateOrBlockedIP("fc00::1")).toBe(true);
      expect(isPrivateOrBlockedIP("fd12:3456:789a:1::1")).toBe(true);
      // Link-Local fe80::/10
      expect(isPrivateOrBlockedIP("fe80::1")).toBe(true);
      expect(isPrivateOrBlockedIP("febf::ffff")).toBe(true);
    });

    it("identifies IPv4-mapped IPv6 addresses for private ranges", () => {
      expect(isPrivateOrBlockedIP("::ffff:127.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIP("::ffff:10.0.0.1")).toBe(true);
      expect(isPrivateOrBlockedIP("::ffff:169.254.169.254")).toBe(true);
      expect(isPrivateOrBlockedIP("::ffff:192.168.1.1")).toBe(true);
      expect(isPrivateOrBlockedIP("::ffff:8.8.8.8")).toBe(false);
    });

    it("allows public IPv4 and IPv6 addresses", () => {
      expect(isPrivateOrBlockedIP("8.8.8.8")).toBe(false);
      expect(isPrivateOrBlockedIP("1.1.1.1")).toBe(false);
      expect(isPrivateOrBlockedIP("93.184.216.34")).toBe(false);
      expect(isPrivateOrBlockedIP("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateOrBlockedIP("2001:4860:4860::8888")).toBe(false);
    });

    it("returns true (blocks) for invalid IP strings", () => {
      expect(isPrivateOrBlockedIP("not-an-ip")).toBe(true);
      expect(isPrivateOrBlockedIP("")).toBe(true);
    });
  });

  describe("assertSafeUrl", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("throws for invalid URL strings", async () => {
      await expect(assertSafeUrl("not-a-valid-url")).rejects.toThrow(SSRFError);
      await expect(assertSafeUrl("")).rejects.toThrow(SSRFError);
    });

    it("rejects non-http(s) protocols", async () => {
      await expect(assertSafeUrl("file:///etc/passwd")).rejects.toThrow(
        /Only HTTP and HTTPS protocols are allowed/
      );
      await expect(assertSafeUrl("ftp://example.com/file")).rejects.toThrow(
        /Only HTTP and HTTPS protocols are allowed/
      );
      await expect(assertSafeUrl("javascript:alert(1)")).rejects.toThrow(
        /Only HTTP and HTTPS protocols are allowed/
      );
      await expect(assertSafeUrl("gopher://example.com")).rejects.toThrow(
        /Only HTTP and HTTPS protocols are allowed/
      );
    });

    it("blocks localhost and local hostnames immediately", async () => {
      await expect(assertSafeUrl("http://localhost/admin")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://localhost:8080/api")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://metadata.google.internal/computeMetadata/v1/")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://app.local")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://internal.internal")).rejects.toThrow(
        /Blocked hostname or IP/
      );
    });

    it("blocks direct private IP addresses in URL", async () => {
      await expect(assertSafeUrl("http://127.0.0.1:3000/api")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://10.0.0.5:8080")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://192.168.1.1/router")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      await expect(assertSafeUrl("http://[::1]:3000")).rejects.toThrow(
        /Blocked hostname or IP/
      );
    });

    it("allows loopback hostnames when allowLoopback is true in non-production", async () => {
      vi.stubEnv("NODE_ENV", "development");
      try {
        await expect(
          assertSafeUrl("http://localhost:3000/api", { allowLoopback: true })
        ).resolves.toBeDefined();
        await expect(
          assertSafeUrl("http://127.0.0.1:8080/api", { allowLoopback: true })
        ).resolves.toBeDefined();
        await expect(
          assertSafeUrl("http://[::1]:8080/api", { allowLoopback: true })
        ).resolves.toBeDefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("blocks loopback even if allowLoopback is true in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      try {
        await expect(
          assertSafeUrl("http://localhost:3000/api", { allowLoopback: true })
        ).rejects.toThrow(/Blocked hostname or IP/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("resolves hostname and blocks if DNS resolves to private IP", async () => {
      vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string, options?: { all?: boolean } & Record<string, unknown>) => {
        if (options?.all) {
          return [{ address: "127.0.0.1", family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
        }
        return { address: "127.0.0.1", family: 4 } as unknown as Awaited<ReturnType<typeof dns.lookup>>;
      });

      await expect(assertSafeUrl("https://evil-spoof.example.com")).rejects.toThrow(
        /resolves to a blocked IP/
      );
    });

    it("resolves hostname and allows if all resolved IPs are public", async () => {
      vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string, options?: { all?: boolean } & Record<string, unknown>) => {
        if (options?.all) {
          return [
            { address: "93.184.216.34", family: 4 },
            { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
          ] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
        }
        return { address: "93.184.216.34", family: 4 } as unknown as Awaited<ReturnType<typeof dns.lookup>>;
      });

      const parsed = await assertSafeUrl("https://example.com/data");
      expect(parsed.hostname).toBe("example.com");
      expect(parsed.pathname).toBe("/data");
    });

    it("blocks if ANY resolved IP is private/blocked", async () => {
      vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string, options?: { all?: boolean } & Record<string, unknown>) => {
        if (options?.all) {
          return [
            { address: "93.184.216.34", family: 4 },
            { address: "10.0.0.1", family: 4 },
          ] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
        }
        return { address: "93.184.216.34", family: 4 } as unknown as Awaited<ReturnType<typeof dns.lookup>>;
      });

      await expect(assertSafeUrl("https://dual-homed.example.com")).rejects.toThrow(
        /resolves to a blocked IP/
      );
    });
  });

  describe("secureFetch", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    it("rejects unsafe URLs before fetching", async () => {
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      await expect(secureFetch("http://127.0.0.1:8080/secret")).rejects.toThrow(
        SSRFError
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetches safe URLs with 10MB response cap and timeout signal", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);

      const fakeResponse = new Response("Hello Secure World", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });

      const mockFetch = vi.fn().mockResolvedValue(fakeResponse);
      globalThis.fetch = mockFetch;

      const res = await secureFetch("https://example.com/test");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("Hello Secure World");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      // Ensure redirect is set to manual to prevent untrusted redirects
      const fetchOpts = mockFetch.mock.calls[0][1];
      expect(fetchOpts.redirect).toBe("manual");
    });

    it("validates redirect location on 301/302/307/308 and follows safe redirect", async () => {
      vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string) => {
        if (hostname === "example.com" || hostname === "cdn.example.com") {
          return [{ address: "93.184.216.34", family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
        }
        return [{ address: "127.0.0.1", family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
      });

      const redirectResponse = new Response(null, {
        status: 302,
        headers: { Location: "https://cdn.example.com/final-data" },
      });
      const finalResponse = new Response("Redirected content", {
        status: 200,
      });

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(finalResponse);
      globalThis.fetch = mockFetch;

      const res = await secureFetch("https://example.com/start");
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("Redirected content");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("rejects redirect leading to private IP / localhost", async () => {
      vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string) => {
        if (hostname === "example.com") {
          return [{ address: "93.184.216.34", family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
        }
        return [{ address: "127.0.0.1", family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>;
      });

      const redirectResponse = new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:3000/internal-data" },
      });

      const mockFetch = vi.fn().mockResolvedValueOnce(redirectResponse);
      globalThis.fetch = mockFetch;

      await expect(secureFetch("https://example.com/start")).rejects.toThrow(
        /Blocked hostname or IP/
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("blocks response exceeding 10MB Content-Length header or stream limit", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);

      const oversizedResponse = new Response("big", {
        status: 200,
        headers: { "Content-Length": "15000000" }, // 15MB
      });

      globalThis.fetch = vi.fn().mockResolvedValue(oversizedResponse);

      await expect(secureFetch("https://example.com/large-file")).rejects.toThrow(
        /Response exceeds the 10MB limit/
      );
    });

    it("handles aborted signal from caller", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);

      const controller = new AbortController();
      controller.abort();

      await expect(
        secureFetch("https://example.com/test", { signal: controller.signal })
      ).rejects.toThrow();
    });

    it("enforces max redirects limit", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);

      const redirectResponse = new Response(null, {
        status: 302,
        headers: { Location: "https://example.com/loop" },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(redirectResponse);

      await expect(
        secureFetch("https://example.com/loop", { maxRedirects: 2 })
      ).rejects.toThrow(/Too many redirects/);
    });

    it("enforces streaming size limit when body exceeds maxBytes during chunk transfer", async () => {
      vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);

      // Create a stream that emits 2 chunks of 1KB with maxBytes = 1000
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(800));
          controller.enqueue(new Uint8Array(800));
          controller.close();
        },
      });

      const streamingResponse = new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });

      globalThis.fetch = vi.fn().mockResolvedValue(streamingResponse);

      const res = await secureFetch("https://example.com/stream", {
        maxBytes: 1000,
      });

      await expect(res.arrayBuffer()).rejects.toThrow(/Response exceeds/);
    });
  });
});
