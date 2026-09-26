import fs from "node:fs/promises";
import { open } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveInstallPaths } from "@/cli/utils/paths";

// This module must NOT import `@/lib/observability/log-store` (or anything else
// that reaches `@/env`): the CLI imports it, and `@/env` parses at import time
// and rejects a production run without APP_SECRET — which would break every
// `yggdrasil` command under `NODE_ENV=production` (exactly what install.sh sets).
// Warnings go to stderr instead, which needs no configuration.
function warn(message: string): void {
  console.warn(`[update-check] ${message}`);
}

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
  // Read the file rather than `require()` it: a JSON require is a CJS import
  // (forbidden in this ESM module) and would cache the value, so a rebuilt
  // install would report a stale version.
  const readVersionFrom = (pkgPath: string): string | null => {
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
      return typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      return null;
    }
  };

  const appDir = customAppDir ?? resolveInstallPaths().appDir;
  const installed = readVersionFrom(path.join(appDir, "package.json"));
  if (installed) return installed;

  // Fall back to this repository's own package.json (running from a checkout).
  return readVersionFrom(path.join(import.meta.dirname, "../../../package.json")) ?? "0.0.0";
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
      warn("GitHub Releases API rate limit exceeded");
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
      warn(`Failed to write update cache: ${writeErr}`);
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
    warn(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
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
