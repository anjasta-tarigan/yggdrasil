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
/** Human-facing releases page; used when a release has no `html_url` recorded. */
export const GITHUB_RELEASES_PAGE_URL =
  "https://github.com/anjasta-tarigan/yggdrasil/releases";
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
  const parsed = parseSemver(getInstalledVersion(customAppDir));
  // Spec fallback for "no marker present": anything that is not a clean
  // release semver is a development build. That covers an unparseable version
  // and a prerelease like `0.0.0-dev` — a valid semver that would otherwise be
  // compared against published tags and wrongly reported as out of date.
  return parsed === null || parsed.prerelease !== undefined;
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

/** Reads the cache file; a missing, unreadable, or corrupt file is a miss. */
async function readStoredCache(cacheFile: string): Promise<StoredReleaseCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile, "utf8")) as StoredReleaseCache;
    if (parsed && typeof parsed.latest === "string") return parsed;
  } catch {
    // Missing, unreadable, or corrupt — callers treat it as a cache miss.
  }
  return null;
}

function isFreshCache(stored: StoredReleaseCache, now: number): boolean {
  return now - stored.checkedAt < CACHE_TTL_MS;
}

/** Builds a result from a stored entry, keeping the timestamp of the real fetch. */
function resultFromStoredCache(
  stored: StoredReleaseCache,
  current: string,
  errored: boolean
): VersionCheckResult {
  const latestClean = stored.latest.replace(/^[vV]/, "");
  return {
    current,
    latest: latestClean,
    available: compareSemver(latestClean, current) > 0,
    channel: "release",
    releaseUrl: stored.releaseUrl,
    releaseNotes: stored.releaseNotes,
    checkedAt: stored.checkedAt,
    errored,
  };
}

/** The "unknown" result: fall back to any stored entry, else an empty errored one. */
function unknownResult(
  stored: StoredReleaseCache | null,
  current: string,
  now: number
): VersionCheckResult {
  if (stored) return resultFromStoredCache(stored, current, true);
  return {
    current,
    latest: null,
    available: false,
    channel: "release",
    releaseUrl: null,
    checkedAt: now,
    errored: true,
  };
}

function remember(result: VersionCheckResult, expiresAt: number): VersionCheckResult {
  memoryCache = { result, expiresAt };
  return result;
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
  let storedCache = await readStoredCache(cacheFile);

  if (storedCache && !options.force && isFreshCache(storedCache, now)) {
    const result = resultFromStoredCache(storedCache, current, false);
    return remember(result, storedCache.checkedAt + CACHE_TTL_MS);
  }

  await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
  const releaseLock = await acquireCacheLock(lockFile);

  if (!releaseLock) {
    // The lock was held past LOCK_WAIT_MS. The winner may have populated the
    // cache in the meantime, so re-read once before giving up with "unknown".
    // A fresh winner result is returned even under `force`: it is a real fetch,
    // and the loser could not have fetched itself while the lock was held.
    storedCache = (await readStoredCache(cacheFile)) ?? storedCache;
    if (storedCache && isFreshCache(storedCache, now)) {
      const result = resultFromStoredCache(storedCache, current, false);
      return remember(result, storedCache.checkedAt + CACHE_TTL_MS);
    }
    return unknownResult(storedCache, current, now);
  }

  try {
    // C1: the winner must re-read the cache after taking the lock. Otherwise
    // every worker that cold-boots together acquires the lock in turn and
    // fetches again, exhausting the 60 req/hour anonymous GitHub budget.
    const rechecked = await readStoredCache(cacheFile);
    if (rechecked && !options.force && isFreshCache(rechecked, now)) {
      storedCache = rechecked;
      const result = resultFromStoredCache(rechecked, current, false);
      return remember(result, rechecked.checkedAt + CACHE_TTL_MS);
    }
    if (rechecked) storedCache = rechecked;

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
      return unknownResult(storedCache, current, now);
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
    return remember(result, now + CACHE_TTL_MS);
  } catch (err: unknown) {
    warn(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return unknownResult(storedCache, current, now);
  } finally {
    await releaseLock();
  }
}
