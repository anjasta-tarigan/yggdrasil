import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseSemver,
  compareSemver,
  getInstalledVersion,
  checkLatestVersion,
  resetVersionCacheForTest,
  UPDATE_CHECK_FETCH_TIMEOUT_MS,
} from "../version";

describe("version parsing and semver comparison", () => {
  it("parses valid semver versions with or without v prefix", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: undefined });
    expect(parseSemver("V0.1.2")).toEqual({ major: 0, minor: 1, patch: 2, prerelease: undefined });
    expect(parseSemver("1.0.0-beta.1")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: "beta.1" });
    expect(parseSemver("invalid")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
  });

  it("correctly compares semver versions", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.1.0", "1.0.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("v1.2.0", "1.1.9")).toBe(1);
  });
});

describe("checkLatestVersion with mocked GitHub API", () => {
  let tmpDir: string;
  let appDir: string;
  let fakeFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetVersionCacheForTest();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-ver-test-"));
    appDir = path.join(tmpDir, "app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "yggdrasil", version: "0.1.0" }),
      "utf8"
    );

    fakeFetch = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("resolves installed version from package.json in appDir", () => {
    expect(getInstalledVersion(appDir)).toBe("0.1.0");
  });

  it("detects when a newer release is available", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
          body: "New features and fixes",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.current).toBe("0.1.0");
    expect(result.latest).toBe("0.2.0");
    expect(result.available).toBe(true);
    expect(result.channel).toBe("release");
    expect(result.releaseUrl).toBe("https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0");
    expect(result.errored).toBe(false);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("returns available=false when installed version is equal or newer", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.1.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.1.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.available).toBe(false);
    expect(result.latest).toBe("0.1.0");
  });

  it("serves from cache on repeated calls within TTL without hitting network", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const first = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000,
    });
    expect(first.available).toBe(true);

    const second = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000 + 30 * 60 * 1000, // 30 mins later (< 1 hour TTL)
    });
    expect(second.available).toBe(true);
    expect(second.latest).toBe("0.2.0");
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("handles rate limiting: returns stale cache with errored=true if cache exists", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.3.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.3.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000,
    });

    // Second call: past 1 hour TTL, rate-limited 403
    fakeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      })
    );

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000 + 2 * 3600 * 1000, // 2 hours later
    });

    expect(result.errored).toBe(true);
    expect(result.latest).toBe("0.3.0");
    expect(result.available).toBe(true); // preserved from cache
    // A stored result must report the time of the real fetch, not "now".
    expect(result.checkedAt).toBe(1000000);
  });

  it("handles rate limiting without cache: returns available=false and errored=true", async () => {
    fakeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      })
    );

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.errored).toBe(true);
    expect(result.available).toBe(false);
    expect(result.latest).toBeNull();
  });

  it("handles main channel by returning channel=main and available=false", async () => {
    vi.stubEnv("YGGDRASIL_CHANNEL", "main");

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: 1000000,
    });

    expect(result.channel).toBe("main");
    expect(result.available).toBe(false);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("recovers from stale lockfile when previous process died", async () => {
    const cacheDir = path.join(path.dirname(appDir), "data", "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const lockPath = path.join(cacheDir, "latest-release.json.lock");

    // Write a stale lock file with an mtime 20 seconds in the past (> 10s LOCK_STALE_MS)
    await fs.writeFile(lockPath, "dead:12345", "utf8");
    const past = new Date(Date.now() - 25000);
    await fs.utimes(lockPath, past, past);

    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.4.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.4.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: Date.now(),
    });

    expect(result.available).toBe(true);
    expect(result.latest).toBe("0.4.0");
    // Lock file should be cleaned up after successful execution
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it("coalesces concurrent calls: two callers share one network fetch", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fakeFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );

    const now = Date.now();
    const first = checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now,
    });
    const second = checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now,
    });

    // Let the winner acquire the lock and enter the fetch before the loser
    // starts polling for the cache file.
    await new Promise((resolve) => setTimeout(resolve, 150));
    resolveFetch(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const [a, b] = await Promise.all([first, second]);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(a.latest).toBe("0.2.0");
    expect(b.latest).toBe("0.2.0");
    expect(a.available).toBe(true);
    expect(b.available).toBe(true);
  });

  it("aborts a hung fetch at UPDATE_CHECK_FETCH_TIMEOUT_MS and releases the lock", async () => {
    const lockPath = path.join(path.dirname(appDir), "data", "cache", "latest-release.json.lock");
    fakeFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          // Mirrors a real fetch: it only settles when the signal aborts.
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          );
        })
    );

    const startedAt = Date.now();
    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: Date.now(),
    });

    expect(result.errored).toBe(true);
    expect(result.available).toBe(false);
    // The abort must fire at the configured timeout, not hang indefinitely.
    expect(Date.now() - startedAt).toBeLessThan(UPDATE_CHECK_FETCH_TIMEOUT_MS + 3000);
    await expect(fs.access(lockPath)).rejects.toThrow();
  }, 20000);

  it("returns an errored result instead of hanging when the lock is held and no cache exists", async () => {
    const cacheDir = path.join(path.dirname(appDir), "data", "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "latest-release.json.lock"), "other:12345", "utf8");

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: Date.now(),
    });

    expect(result.errored).toBe(true);
    expect(result.available).toBe(false);
    expect(result.latest).toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
  }, 20000);

  it("treats a corrupt cache file as a miss and re-fetches without throwing", async () => {
    const cacheDir = path.join(path.dirname(appDir), "data", "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "latest-release.json"), "{not valid json", "utf8");

    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: Date.now(),
    });

    expect(result.latest).toBe("0.2.0");
    expect(result.errored).toBe(false);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("warns and still returns a result when the cache write is denied", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Simulate a read-only cache dir by failing the atomic rename.
    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));

    fakeFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    try {
      const result = await checkLatestVersion({
        appDir,
        fetchFn: fakeFetch as unknown as typeof fetch,
        now: Date.now(),
      });

      expect(result.available).toBe(true);
      expect(result.errored).toBe(false);
      expect(renameSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("does not flag a 0.0.0-dev prerelease build as an available release", async () => {
    await fs.writeFile(
      path.join(appDir, "package.json"),
      JSON.stringify({ name: "yggdrasil", version: "0.0.0-dev" }),
      "utf8"
    );

    const result = await checkLatestVersion({
      appDir,
      fetchFn: fakeFetch as unknown as typeof fetch,
      now: Date.now(),
    });

    expect(result.available).toBe(false);
    expect(result.channel).toBe("main");
    expect(fakeFetch).not.toHaveBeenCalled();
  });
});
