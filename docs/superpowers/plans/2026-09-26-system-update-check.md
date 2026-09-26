# System Update Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement passive system update checking for Yggdrasil across CLI (`yggdrasil check-update`), background startup cache, REST API, and Settings UI with per-release dismissible alerts.

**Architecture:** A unified core version module (`src/lib/system/version.ts`) resolves installed versions, performs atomic cache operations with `O_EXCL` cross-process locking and stale-lock recovery, queries GitHub Releases API with timeout/rate-limiting, and normalizes semver. A non-blocking startup check in `bootstrap.ts` warms the cache. A loopback/Bearer-guarded endpoint (`/api/system/update-check`) serves status and records dismiss state in the SQLite settings store. A React client component (`UpdateCheck.tsx`) renders inside the Settings About tab, and a CLI subcommand (`yggdrasil check-update`) provides scriptable exit codes (`0`, `1`, `2`).

**Tech Stack:** Node.js (>=22.13.0), Next.js 16 (App Router), TypeScript, SQLite (Drizzle ORM), React 19, Tailwind CSS v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-26-system-update-check-design.md`

## Global Constraints

- Never auto-download, auto-install, or auto-restart code; update discovery is strictly passive.
- Runtime Node.js minimum is `>=22.13.0`.
- All network fetches to GitHub must include `User-Agent: yggdrasil` and an explicit 5000ms timeout (`UPDATE_CHECK_FETCH_TIMEOUT_MS`).
- File cache (`data/cache/latest-release.json`) must be written atomically via temp-file write + rename.
- Cross-process concurrency must use an atomic `O_EXCL` sidecar lock (`data/cache/latest-release.json.lock`) with 10s stale recovery (`LOCK_STALE_MS`) and 3s polling wait (`LOCK_WAIT_MS`).
- Rate-limited responses (403 / remaining quota 0) must never be treated as fresh "up-to-date" results; stale cache is returned with `errored: true`, or `{ available: false, errored: true }` if no cache exists.
- The `main` development channel must be detected via explicit marker (`YGGDRASIL_CHANNEL=main` or `git describe`) and must return `channel: "main", available: false`.
- The API route must enforce loopback or Bearer `APP_SECRET` authentication, and CSRF Origin/Referer check on mutating requests.
- `releaseNotes` must be sanitized plain text and never rendered with `dangerouslySetInnerHTML`.
- All tests must use mocked `fetch` with no external network calls during CI runs.

---

### Task 1: Core Version and Update Resolution Module

**Files:**
- Create: `src/lib/system/version.ts`
- Create: `src/lib/system/__tests__/version.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface VersionCheckResult {
    current: string;
    latest: string | null;
    available: boolean;
    channel: "release" | "main";
    releaseUrl: string | null;
    releaseNotes?: string | null;
    checkedAt: number;
    errored: boolean;
  }
  export function parseSemver(v: string): { major: number; minor: number; patch: number; prerelease?: string } | null;
  export function compareSemver(a: string, b: string): number;
  export function getInstalledVersion(customAppDir?: string): string;
  export function isMainChannel(customAppDir?: string): boolean;
  export function checkLatestVersion(options?: {
    appDir?: string;
    fetchFn?: typeof fetch;
    now?: number;
    force?: boolean;
  }): Promise<VersionCheckResult>;
  export function resetVersionCacheForTest(): void;
  ```

- [ ] **Step 1: Write the failing tests for version resolution and locking**

Create `src/lib/system/__tests__/version.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseSemver,
  compareSemver,
  getInstalledVersion,
  isMainChannel,
  checkLatestVersion,
  resetVersionCacheForTest,
  type VersionCheckResult,
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/system/__tests__/version.test.ts --maxWorkers=1`
Expected: FAIL (Cannot find module `../version`)

- [ ] **Step 3: Write minimal implementation in `src/lib/system/version.ts`**

Create `src/lib/system/version.ts`:
```typescript
import fs from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths } from "@/cli/utils/paths";
import { syslog } from "@/lib/observability/log-store";

export interface VersionCheckResult {
  current: string;
  latest: string | null;
  available: boolean;
  channel: "release" | "main";
  releaseUrl: string | null;
  releaseNotes?: string | null;
  checkedAt: number;
  errored: boolean;
}

interface StoredReleaseCache {
  latest: string;
  releaseUrl: string;
  releaseNotes?: string | null;
  checkedAt: number;
}

export const GITHUB_RELEASES_LATEST_URL =
  "https://api.github.com/repos/anjasta-tarigan/yggdrasil/releases/latest";
export const UPDATE_CHECK_FETCH_TIMEOUT_MS = 5000;
export const CACHE_TTL_MS = 3600000; // 1 hour
export const LOCK_STALE_MS = 10000; // 10s (2x fetch timeout)
export const LOCK_WAIT_MS = 3000;
export const LOCK_POLL_MS = 100;

let memoryCache: { result: VersionCheckResult; expiresAt: number } | null = null;

export function resetVersionCacheForTest(): void {
  memoryCache = null;
}

export function parseSemver(v: string): { major: number; minor: number; patch: number; prerelease?: string } | null {
  const clean = v.trim().replace(/^[vV]/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(clean);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && pb.prerelease) {
    return pa.prerelease.localeCompare(pb.prerelease);
  }
  return 0;
}

export function getInstalledVersion(customAppDir?: string): string {
  try {
    const paths = resolveInstallPaths();
    const appDir = customAppDir ?? paths.appDir;
    const pkgPath = path.join(appDir, "package.json");
    // Synchronous load via node fs is not strictly required; readFileSync or import
    const content = require(pkgPath);
    return typeof content.version === "string" ? content.version : "0.0.0";
  } catch {
    try {
      const rootPkg = require("../../../package.json");
      return typeof rootPkg.version === "string" ? rootPkg.version : "0.0.0";
    } catch {
      return "0.0.0";
    }
  }
}

export function isMainChannel(customAppDir?: string): boolean {
  if (process.env.YGGDRASIL_CHANNEL === "main") return true;
  const version = getInstalledVersion(customAppDir);
  return parseSemver(version) === null;
}

function resolveCachePaths(customAppDir?: string) {
  let baseDir: string;
  if (customAppDir) {
    baseDir = path.dirname(path.resolve(customAppDir));
  } else {
    baseDir = resolveInstallPaths().baseDir;
  }
  const cacheDir = path.join(baseDir, "data", "cache");
  return {
    cacheDir,
    cacheFile: path.join(cacheDir, "latest-release.json"),
    lockFile: path.join(cacheDir, "latest-release.json.lock"),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireCacheLock(lockFile: string): Promise<(() => Promise<void>) | null> {
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(lockFile, "wx");
      await handle.writeFile(`${process.pid}:${Date.now()}`, "utf8");
      await handle.close();
      return async () => {
        await fs.unlink(lockFile).catch(() => {});
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return null;
      }
    }

    try {
      const stat = await fs.stat(lockFile);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lockFile).catch(() => {});
        continue;
      }
    } catch {
      continue;
    }

    if (Date.now() - start >= LOCK_WAIT_MS) {
      return null;
    }
    await sleep(LOCK_POLL_MS);
  }
}

export async function checkLatestVersion(options: {
  appDir?: string;
  fetchFn?: typeof fetch;
  now?: number;
  force?: boolean;
} = {}): Promise<VersionCheckResult> {
  const current = getInstalledVersion(options.appDir);
  const now = options.now ?? Date.now();
  const fetcher = options.fetchFn ?? globalThis.fetch;

  if (isMainChannel(options.appDir)) {
    return {
      current,
      latest: null,
      available: false,
      channel: "main",
      releaseUrl: null,
      checkedAt: now,
      errored: false,
    };
  }

  if (!options.force && memoryCache && memoryCache.expiresAt > now) {
    return memoryCache.result;
  }

  const { cacheDir, cacheFile, lockFile } = resolveCachePaths(options.appDir);
  let storedCache: StoredReleaseCache | null = null;

  try {
    const raw = await fs.readFile(cacheFile, "utf8");
    storedCache = JSON.parse(raw) as StoredReleaseCache;
    if (storedCache && typeof storedCache.latest === "string") {
      const isFresh = now - storedCache.checkedAt < CACHE_TTL_MS;
      if (!options.force && isFresh) {
        const latestClean = storedCache.latest.replace(/^[vV]/, "");
        const available = compareSemver(latestClean, current) > 0;
        const result: VersionCheckResult = {
          current,
          latest: latestClean,
          available,
          channel: "release",
          releaseUrl: storedCache.releaseUrl,
          releaseNotes: storedCache.releaseNotes,
          checkedAt: storedCache.checkedAt,
          errored: false,
        };
        memoryCache = { result, expiresAt: storedCache.checkedAt + CACHE_TTL_MS };
        return result;
      }
    }
  } catch {
    // Missing, unreadable, or corrupt cache file
  }

  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
  const releaseLock = await acquireCacheLock(lockFile);

  if (!releaseLock) {
    // Winner may have just populated the cache; check one last time
    try {
      const raw = await fs.readFile(cacheFile, "utf8");
      storedCache = JSON.parse(raw) as StoredReleaseCache;
      if (storedCache && typeof storedCache.latest === "string") {
        const latestClean = storedCache.latest.replace(/^[vV]/, "");
        return {
          current,
          latest: latestClean,
          available: compareSemver(latestClean, current) > 0,
          channel: "release",
          releaseUrl: storedCache.releaseUrl,
          releaseNotes: storedCache.releaseNotes,
          checkedAt: storedCache.checkedAt,
          errored: false,
        };
      }
    } catch {
      // no cache
    }

    return {
      current,
      latest: storedCache ? storedCache.latest.replace(/^[vV]/, "") : null,
      available: storedCache ? compareSemver(storedCache.latest.replace(/^[vV]/, ""), current) > 0 : false,
      channel: "release",
      releaseUrl: storedCache?.releaseUrl ?? null,
      releaseNotes: storedCache?.releaseNotes,
      checkedAt: now,
      errored: true,
    };
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "yggdrasil",
      Accept: "application/vnd.github.v3+json",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    } else if (process.env.GH_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPDATE_CHECK_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetcher(GITHUB_RELEASES_LATEST_URL, {
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (res.status === 403 || res.headers.get("x-ratelimit-remaining") === "0") {
      syslog("warn", "update-check", "GitHub Releases API rate limit exceeded");
      return {
        current,
        latest: storedCache ? storedCache.latest.replace(/^[vV]/, "") : null,
        available: storedCache ? compareSemver(storedCache.latest.replace(/^[vV]/, ""), current) > 0 : false,
        channel: "release",
        releaseUrl: storedCache?.releaseUrl ?? null,
        releaseNotes: storedCache?.releaseNotes,
        checkedAt: now,
        errored: true,
      };
    }

    if (!res.ok) {
      throw new Error(`GitHub API returned status ${res.status}`);
    }

    const data = (await res.json()) as { tag_name?: unknown; html_url?: unknown; body?: unknown };
    if (typeof data.tag_name !== "string") {
      throw new Error("Missing tag_name in GitHub release payload");
    }

    const latestClean = data.tag_name.replace(/^[vV]/, "");
    if (!parseSemver(latestClean)) {
      throw new Error(`Invalid semver in release tag: ${data.tag_name}`);
    }

    const releaseUrl = typeof data.html_url === "string" ? data.html_url : null;
    const releaseNotes = typeof data.body === "string" ? data.body.slice(0, 1000).trim() : null;
    const available = compareSemver(latestClean, current) > 0;

    const newCache: StoredReleaseCache = {
      latest: latestClean,
      releaseUrl: releaseUrl ?? "",
      releaseNotes,
      checkedAt: now,
    };

    // Atomic write: write to temp file then rename
    const tempFile = path.join(cacheDir, `latest-release.json.tmp.${process.pid}.${Date.now()}`);
    try {
      await fs.writeFile(tempFile, JSON.stringify(newCache), "utf8");
      await fs.rename(tempFile, cacheFile);
    } catch (writeErr) {
      syslog("warn", "update-check", `Failed to write update cache: ${writeErr}`);
      await fs.unlink(tempFile).catch(() => {});
    }

    const result: VersionCheckResult = {
      current,
      latest: latestClean,
      available,
      channel: "release",
      releaseUrl,
      releaseNotes,
      checkedAt: now,
      errored: false,
    };
    memoryCache = { result, expiresAt: now + CACHE_TTL_MS };
    return result;
  } catch (err: unknown) {
    syslog("warn", "update-check", `Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      current,
      latest: storedCache ? storedCache.latest.replace(/^[vV]/, "") : null,
      available: storedCache ? compareSemver(storedCache.latest.replace(/^[vV]/, ""), current) > 0 : false,
      channel: "release",
      releaseUrl: storedCache?.releaseUrl ?? null,
      releaseNotes: storedCache?.releaseNotes,
      checkedAt: now,
      errored: true,
    };
  } finally {
    await releaseLock();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/system/__tests__/version.test.ts --maxWorkers=1`
Expected: PASS (all tests green)

- [ ] **Step 5: Commit**

```bash
git add src/lib/system/version.ts src/lib/system/__tests__/version.test.ts
git commit -m "feat(system): implement core version comparison and update resolution module"
```

---

### Task 2: Fire-and-Forget Startup Check in Bootstrap

**Files:**
- Modify: `src/lib/bootstrap.ts`
- Create: `src/lib/__tests__/bootstrap-update-check.test.ts`

**Interfaces:**
- Consumes: `checkLatestVersion` from `@/lib/system/version`
- Modifies: `bootstrapAutonomousCognitiveSystem` in `src/lib/bootstrap.ts`

- [ ] **Step 1: Write failing test for bootstrap update check**

Create `src/lib/__tests__/bootstrap-update-check.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkLatestVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  current: "0.1.0",
  latest: "0.2.0",
  available: true,
  channel: "release",
  releaseUrl: "https://example.com",
  checkedAt: Date.now(),
  errored: false,
}));

vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: checkLatestVersionMock,
}));

describe("bootstrap startup update check", () => {
  beforeEach(() => {
    checkLatestVersionMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers checkLatestVersion asynchronously during bootstrap without throwing", async () => {
    const { bootstrapAutonomousCognitiveSystem } = await import("../bootstrap");
    const fakeDb = {
      select: () => ({ from: () => ({ where: () => ({ all: () => [] }) }) }),
    } as any;

    bootstrapAutonomousCognitiveSystem(fakeDb);
    expect(checkLatestVersionMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/bootstrap-update-check.test.ts --maxWorkers=1`
Expected: FAIL (expect(checkLatestVersionMock).toHaveBeenCalled() failed)

- [ ] **Step 3: Update `src/lib/bootstrap.ts` to invoke `checkLatestVersion()`**

Add to `src/lib/bootstrap.ts`:
```typescript
import { checkLatestVersion } from "@/lib/system/version";
```
Inside `bootstrapAutonomousCognitiveSystem(dbInstance)`:
```typescript
  // 4. Non-blocking update check to warm the release cache
  if (process.env.NODE_ENV !== "test") {
    checkLatestVersion().catch((err) => {
      syslog("warn", "update-check", `Startup update check failed: ${err}`);
    });
  } else {
    // In test environment, invoke so test verifications work
    checkLatestVersion().catch(() => {});
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/bootstrap-update-check.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/bootstrap.ts src/lib/__tests__/bootstrap-update-check.test.ts
git commit -m "feat(bootstrap): trigger passive update check during startup"
```

---

### Task 3: Security Guard and System Update Check REST API Route

**Files:**
- Create: `src/app/api/system/guard.ts`
- Create: `src/app/api/system/update-check/route.ts`
- Create: `src/app/api/system/__tests__/update-check-route.test.ts`

**Interfaces:**
- Produces: `GET /api/system/update-check` and `POST /api/system/update-check`
- Consumes: `checkLatestVersion` from `@/lib/system/version`, `getSettingDb`, `setSettingsDb` from `@/lib/settings-service`

- [ ] **Step 1: Write failing tests for update check API route**

Create `src/app/api/system/__tests__/update-check-route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkLatestVersionMock = vi.hoisted(() => vi.fn());
const getSettingDbMock = vi.hoisted(() => vi.fn());
const setSettingsDbMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: checkLatestVersionMock,
}));

vi.mock("@/lib/settings-service", () => ({
  getSettingDb: getSettingDbMock,
  setSettingsDb: setSettingsDbMock,
}));

import { GET, POST } from "../update-check/route";

describe("GET & POST /api/system/update-check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET returns version information and dismissed=false when release is not dismissed", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.2.0",
      releaseNotes: "Some release notes",
      checkedAt: 12345,
      errored: false,
    });
    getSettingDbMock.mockReturnValue(null);

    const req = new Request("http://127.0.0.1:3000/api/system/update-check");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.current).toBe("0.1.0");
    expect(data.latest).toBe("0.2.0");
    expect(data.available).toBe(true);
    expect(data.dismissed).toBe(false);
  });

  it("GET returns dismissed=true when current latest version matches dismissed setting", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.2.0",
      checkedAt: 12345,
      errored: false,
    });
    getSettingDbMock.mockReturnValue({ version: "0.2.0", dismissedAt: 12000 });

    const req = new Request("http://127.0.0.1:3000/api/system/update-check");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dismissed).toBe(true);
  });

  it("GET returns dismissed=false when a newer version arrives after an older version was dismissed", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.3.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.3.0",
      checkedAt: 12345,
      errored: false,
    });
    getSettingDbMock.mockReturnValue({ version: "0.2.0", dismissedAt: 12000 });

    const req = new Request("http://127.0.0.1:3000/api/system/update-check");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.dismissed).toBe(false);
  });

  it("POST dismiss saves the dismissed version to settings store", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/release/v0.2.0",
      checkedAt: 12345,
      errored: false,
    });

    const req = new Request("http://127.0.0.1:3000/api/system/update-check", {
      method: "POST",
      headers: {
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "dismiss" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(setSettingsDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        system_update_dismissed: expect.objectContaining({
          version: "0.2.0",
        }),
      })
    );
  });

  it("POST rejects missing Origin on mutating requests", async () => {
    const req = new Request("http://127.0.0.1:3000/api/system/update-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/system/__tests__/update-check-route.test.ts --maxWorkers=1`
Expected: FAIL (Cannot find module `../update-check/route`)

- [ ] **Step 3: Implement `src/app/api/system/guard.ts`**

Create `src/app/api/system/guard.ts`:
```typescript
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { env, refreshEnv } from "@/env";
import { syslog } from "@/lib/observability/log-store";

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function isLocalRequest(req: Request): boolean {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstHop = forwardedFor.split(",")[0]?.trim();
    if (firstHop && !isLoopbackHostname(firstHop)) return false;
  }

  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp && !isLoopbackHostname(realIp)) return false;

  const forwarded = req.headers.get("forwarded");
  if (forwarded && /for=/i.test(forwarded)) {
    const value = forwarded.split(",")[0] ?? "";
    const match = /for="?\[?([^";\]]+)\]?"?/i.exec(value);
    const forHost = match?.[1]?.trim();
    if (forHost && !isLoopbackHostname(forHost)) return false;
  }

  const hostHeader = req.headers.get("host");
  let hostname: string | null = null;
  if (hostHeader) {
    try {
      hostname = new URL(hostHeader.includes("://") ? hostHeader : `http://${hostHeader}`).hostname;
    } catch {
      hostname = null;
    }
  }

  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch {
      return false;
    }
  }

  return isLoopbackHostname(hostname);
}

function isAllowedHost(urlStr: string, hostHeader: string | null): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    if (isLoopbackHostname(hostname)) return true;

    if (hostHeader) {
      try {
        const expectedUrl = new URL(hostHeader.includes("://") ? hostHeader : `http://${hostHeader}`);
        if (hostname === expectedUrl.hostname.toLowerCase()) {
          const expectedPort = expectedUrl.port;
          if (!expectedPort || !url.port || expectedPort === url.port) return true;
        }
      } catch {
        // invalid host
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function validateSystemApiRequest(
  req: Request,
  options?: { requireJsonBody?: boolean }
): NextResponse | null {
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  const secret = currentEnv.APP_SECRET;
  const authHeader = req.headers.get("authorization");
  const isLocal = isLocalRequest(req);

  // 1. Caller Authentication
  if (secret && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (!timingSafeEqualStr(token, secret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (!isLocal) {
    return NextResponse.json(
      {
        error: secret
          ? "Unauthorized"
          : "Unauthorized: APP_SECRET required in production",
      },
      { status: 401 }
    );
  }

  // 2. CSRF on Mutating requests
  const method = req.method.toUpperCase();
  const isMutating = ["POST", "PATCH", "DELETE", "PUT"].includes(method);

  if (isMutating) {
    let hostHeader = req.headers.get("host");
    if (!hostHeader) {
      try {
        hostHeader = new URL(req.url).host;
      } catch {
        hostHeader = null;
      }
    }

    const origin = req.headers.get("origin");
    if (origin) {
      if (!isAllowedHost(origin, hostHeader)) {
        return NextResponse.json({ error: "Forbidden: invalid origin" }, { status: 403 });
      }
    } else {
      const referer = req.headers.get("referer");
      if (referer) {
        if (!isAllowedHost(referer, hostHeader)) {
          return NextResponse.json({ error: "Forbidden: invalid referer" }, { status: 403 });
        }
      } else {
        return NextResponse.json({ error: "Forbidden: Origin or Referer header required" }, { status: 403 });
      }
    }

    // 3. Content-Type check
    const contentType = req.headers.get("content-type");
    const expectsBody = options?.requireJsonBody ?? (method === "POST" || method === "PATCH");
    if (expectsBody && (!contentType || !contentType.toLowerCase().includes("application/json"))) {
      return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
    }
  }

  return null;
}
```

- [ ] **Step 4: Implement `src/app/api/system/update-check/route.ts`**

Create `src/app/api/system/update-check/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { checkLatestVersion } from "@/lib/system/version";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { validateSystemApiRequest } from "../guard";

export const dynamic = "force-dynamic";

const DISMISSED_SETTING_KEY = "system_update_dismissed";

interface DismissedSetting {
  version: string;
  dismissedAt: number;
}

export async function GET(req: Request) {
  const guard = validateSystemApiRequest(req);
  if (guard) return guard;

  const check = await checkLatestVersion();
  const dismissedSetting = getSettingDb(DISMISSED_SETTING_KEY) as DismissedSetting | null;

  const isDismissed = Boolean(
    check.latest &&
      dismissedSetting &&
      typeof dismissedSetting.version === "string" &&
      dismissedSetting.version === check.latest
  );

  return NextResponse.json({
    current: check.current,
    latest: check.latest,
    available: check.available,
    channel: check.channel,
    releaseUrl: check.releaseUrl,
    releaseNotes: check.releaseNotes ?? null,
    dismissed: isDismissed,
    errored: check.errored,
  });
}

export async function POST(req: Request) {
  const guard = validateSystemApiRequest(req, { requireJsonBody: true });
  if (guard) return guard;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || (body as { action?: string }).action !== "dismiss") {
    return NextResponse.json({ error: "Invalid action. Expected { action: 'dismiss' }" }, { status: 400 });
  }

  const check = await checkLatestVersion();
  if (check.latest) {
    setSettingsDb({
      [DISMISSED_SETTING_KEY]: {
        version: check.latest,
        dismissedAt: Date.now(),
      },
    });
  }

  return NextResponse.json({ ok: true, dismissed: true, version: check.latest });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/system/__tests__/update-check-route.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/api/system/guard.ts src/app/api/system/update-check/route.ts src/app/api/system/__tests__/update-check-route.test.ts
git commit -m "feat(api): add update check endpoint and system API security guard"
```

---

### Task 4: CLI Command `yggdrasil check-update`

**Files:**
- Create: `src/cli/commands/check-update.ts`
- Modify: `src/cli/index.ts`
- Create: `src/cli/__tests__/check-update.test.ts`

**Interfaces:**
- Produces: `checkUpdateCommand(options: CliOptions): Promise<void>`
- Modifies: `src/cli/index.ts` to add `"check-update"` to CLI subcommand parser

- [ ] **Step 1: Write failing test for `checkUpdateCommand`**

Create `src/cli/__tests__/check-update.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkLatestVersionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: checkLatestVersionMock,
}));

import { checkUpdateCommand } from "../commands/check-update";
import { parseCliArgs } from "../index";

describe("yggdrasil check-update CLI command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("parses check-update subcommand in CLI arguments", () => {
    const parsed = parseCliArgs(["check-update"]);
    expect(parsed.command).toBe("check-update");
  });

  it("prints update available and sets exitCode to 1 when a newer release exists", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
      errored: false,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(1);
    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("Update available: v0.2.0");
    expect(logs).toContain("yggdrasil update");
  });

  it("prints up-to-date and sets exitCode to 0 when no newer release exists", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.2.0",
      latest: "0.2.0",
      available: false,
      channel: "release",
      releaseUrl: null,
      errored: false,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(0);
    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("Yggdrasil is up to date (v0.2.0)");
  });

  it("prints development message and sets exitCode to 0 when on main channel", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0-dev",
      latest: null,
      available: false,
      channel: "main",
      releaseUrl: null,
      errored: false,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(0);
    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("main branch (development build)");
  });

  it("prints error and sets exitCode to 2 when check errored", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: null,
      available: false,
      channel: "release",
      releaseUrl: null,
      errored: true,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(2);
    const errors = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("Could not verify the latest release");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/check-update.test.ts --maxWorkers=1`
Expected: FAIL (Cannot find module `../commands/check-update`)

- [ ] **Step 3: Implement `src/cli/commands/check-update.ts`**

Create `src/cli/commands/check-update.ts`:
```typescript
import { resolveInstallPaths } from "../utils/paths";
import { checkLatestVersion } from "@/lib/system/version";
import type { CliOptions } from "../types";

export async function checkUpdateCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);
  const check = await checkLatestVersion({ appDir: paths.appDir });

  if (check.channel === "main") {
    console.log(
      `[Yggdrasil] Running main branch (development build). Update checking skipped.`
    );
    process.exitCode = 0;
    return;
  }

  if (check.errored) {
    console.error(
      `[Yggdrasil] Could not verify the latest release from GitHub. (Current installed version: v${check.current})`
    );
    process.exitCode = 2;
    return;
  }

  if (check.available && check.latest) {
    console.log(
      `[Yggdrasil] Update available: v${check.latest} (installed: v${check.current})`
    );
    console.log(`[Yggdrasil] Run "yggdrasil update" or visit ${check.releaseUrl ?? "GitHub"} to update.`);
    process.exitCode = 1;
    return;
  }

  console.log(`[Yggdrasil] Yggdrasil is up to date (v${check.current}).`);
  process.exitCode = 0;
}
```

- [ ] **Step 4: Update `src/cli/index.ts`**

In `src/cli/index.ts`:
Import:
```typescript
import { checkUpdateCommand } from "./commands/check-update";
```
In `switch (command)` in `main`:
```typescript
    case "check-update":
      await checkUpdateCommand(options);
      break;
```
In `--help` / `help`:
```text
  check-update Check for system updates from GitHub releases
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/cli/__tests__/check-update.test.ts src/cli/__tests__/commands.test.ts --maxWorkers=1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/check-update.ts src/cli/index.ts src/cli/__tests__/check-update.test.ts
git commit -m "feat(cli): add yggdrasil check-update command"
```

---

### Task 5: Settings UI Update Check Banner / Badge

**Files:**
- Create: `src/components/settings/UpdateCheck.tsx`
- Modify: `src/components/settings/tabs.tsx`
- Create: `src/components/settings/__tests__/UpdateCheck.test.tsx`

**Interfaces:**
- Produces: `<UpdateCheck />` component that polls `/api/system/update-check` and mounts inside `AboutTab`.
- Handles: "Dismiss" button click which posts to `/api/system/update-check`.

- [ ] **Step 1: Write failing component test for `<UpdateCheck />`**

Create `src/components/settings/__tests__/UpdateCheck.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { UpdateCheck } from "../UpdateCheck";

describe("UpdateCheck component", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders update available banner when update is available and not dismissed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/system/update-check")) {
        return new Response(
          JSON.stringify({
            current: "0.1.0",
            latest: "0.2.0",
            available: true,
            channel: "release",
            releaseUrl: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
            dismissed: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(null, { status: 404 });
    });

    render(<UpdateCheck />);

    await waitFor(() => {
      expect(screen.getByText(/Update v0.2.0 available/i)).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: /view/i });
    expect(link).toHaveAttribute("href", "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders nothing when up to date or already dismissed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          current: "0.2.0",
          latest: "0.2.0",
          available: false,
          dismissed: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const { container } = render(<UpdateCheck />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("calls dismiss API and hides the banner when Dismiss is clicked", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        return new Response(JSON.stringify({ ok: true, dismissed: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          current: "0.1.0",
          latest: "0.2.0",
          available: true,
          channel: "release",
          releaseUrl: "https://github.com/release/v0.2.0",
          dismissed: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<UpdateCheck />);

    await waitFor(() => {
      expect(screen.getByText(/Update v0.2.0 available/i)).toBeInTheDocument();
    });

    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/system/update-check",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "dismiss" }),
        })
      );
      expect(screen.queryByText(/Update v0.2.0 available/i)).not.toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/__tests__/UpdateCheck.test.tsx --maxWorkers=1`
Expected: FAIL (Cannot find module `../UpdateCheck`)

- [ ] **Step 3: Implement `src/components/settings/UpdateCheck.tsx`**

Create `src/components/settings/UpdateCheck.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import { ArrowSquareOut, ArrowUpCircle, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  channel: "release" | "main";
  releaseUrl: string | null;
  dismissed: boolean;
  releaseNotes?: string | null;
}

export function UpdateCheck() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissedLocally, setDismissedLocally] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/system/update-check", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as UpdateStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // network or server offline
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || !status.available || status.dismissed || dismissedLocally || !status.latest) {
    return null;
  }

  const handleDismiss = async () => {
    setDismissedLocally(true);
    try {
      await fetch("/api/system/update-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
    } catch {
      // keep local dismissal anyway
    }
  };

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <ArrowUpCircle className="size-4 shrink-0 text-primary" weight="fill" />
        <span className="font-medium text-foreground truncate">
          Update v{status.latest} available
        </span>
        <Badge variant="outline" className="hidden sm:inline-flex text-[10px] font-mono py-0">
          installed: v{status.current}
        </Badge>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {status.releaseUrl && (
          <Button
            asChild
            size="xs"
            variant="outline"
            className="h-7 text-xs gap-1 border-primary/30 text-primary hover:bg-primary/10"
          >
            <a
              href={status.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View release on GitHub"
            >
              <span>View</span>
              <ArrowSquareOut className="size-3" />
            </a>
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={handleDismiss}
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Dismiss update notification"
          title="Dismiss update"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount `<UpdateCheck />` in `AboutTab` in `src/components/settings/tabs.tsx`**

In `src/components/settings/tabs.tsx`:
Add import:
```tsx
import { UpdateCheck } from "@/components/settings/UpdateCheck";
```
Inside `AboutTab`:
```tsx
export function AboutTab({ about }: AboutTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {about?.name ?? "Yggdrasil"}
          {about?.version && (
            <Badge variant="secondary">v{about.version}</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Self-hosted AI workspace with chat, memory, tools, providers, and
          local operations.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <UpdateCheck />
        <div className="flex flex-col gap-1.5 pt-1">
          <ConfigRow label="Stack" value={about?.stack ?? "—"} />
          <ConfigRow label="Model catalog" value="models.dev with provider metadata" />
          <ConfigRow label="Runtime" value="Local SQLite, MCP, skills, cron, and cognitive memory" />
        </div>
        <p className="pt-2 text-muted-foreground text-xs">
          Conversations, settings, memories, and tool configuration stay in
          the local SQLite database. Model requests go only to the providers
          you configure.
        </p>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/components/settings/__tests__/UpdateCheck.test.tsx --maxWorkers=1`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/UpdateCheck.tsx src/components/settings/tabs.tsx src/components/settings/__tests__/UpdateCheck.test.tsx
git commit -m "feat(ui): add UpdateCheck component in settings about tab"
```

---

### Task 6: Documentation and Full Suite Verification

**Files:**
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Update CLI documentation in `README.md` and `CONTRIBUTING.md`**

In `README.md` under `## Service Management CLI`, add `yggdrasil check-update`:
```markdown
| `yggdrasil check-update` | Check for newer releases published on GitHub without downloading |
```
In `CONTRIBUTING.md` under `## What Users Get`:
Mention update discovery:
```markdown
- Update discovery: `yggdrasil check-update` checks whether a newer GitHub release is available; Settings -> About shows an actionable badge.
```

- [ ] **Step 2: Run type check, lint, and full test suite**

Run commands sequentially:
```bash
pnpm exec tsc --noEmit
pnpm exec eslint src/
pnpm test
```
Expected: All exit 0 with 0 errors.

- [ ] **Step 3: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: document yggdrasil check-update and update check feature"
```

---

## Plan Review Checklist

- [x] **Spec coverage:** All sections (§3.1, §3.2, §3.3, §3.4, §3.5, §4, §5, §6) mapped to Tasks 1 through 6.
- [x] **No placeholders:** Every step contains exact paths, full code blocks, and precise commands.
- [x] **Type consistency:** `VersionCheckResult`, `checkLatestVersion`, and `UpdateStatus` share identical field naming (`current`, `latest`, `available`, `channel`, `releaseUrl`, `releaseNotes`, `dismissed`, `errored`).
- [x] **Red-green TDD:** Each task defines explicit failing tests before code implementation.
