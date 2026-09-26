# System Update Check — Design

- **Status:** approved
- **Date:** 2026-09-26
- **Branch:** development

## 1. Goal

Let a Yggdrasil deployment discover whether a newer release is published, both
from the CLI and the in-app Settings UI, without performing any automatic
download or execution. Discovery is passive: one check at process startup, a
badge in Settings if an update is available, and a click that opens the release
page. Dismissing the badge is remembered per-release in the local settings store.

This matches the existing security posture: updates are never automatic. The
`yggdrasil update` command (and the installer) remain the only paths that pull
and rebuild code, and both require an explicit user action plus a database
backup.

## 2. Scope

In scope:
- `yggdrasil check-update` CLI subcommand (informational; meaningful exit code).
- One startup check that populates a short-lived cache.
- A backend API route the UI calls to learn update state and to record a dismiss.
- A Settings panel badge + dismiss control.
- A shared version-comparison module used by both CLI and UI.

Out of scope:
- Automatic download, install, or restart (those stay behind `update` / installer).
- A `main`-channel update signal (see §4); `main` builds are treated as
  up-to-date / skipped.
- Self-updating service, background polling timer, or any server-side scheduler.

## 3. Components

### 3.1 `src/lib/system/version.ts` (new)
Single source of truth for version logic. Used by both CLI and the API route.

- `getInstalledVersion(appDir?: string): string` — reads `package.json` from the
  app directory (resolves `app/` via `resolveInstallPaths` so the CLI, run from
  outside `app/`, reads the right file). Returns the `version` field.
- Cache location is resolved through the **same** `resolveInstallPaths` as the
  above, so `check-update --dir <dir>` and the server agree on one cache file at
  `data/cache/latest-release.json`.
- **Version normalization:** reads `tag_name` from the GitHub release object and
  strips a single leading `v`/`V` before comparing. Both `latest` and `current`
  are normalized the same way, then passed to a semver comparator. (GitHub
  `tag_name` is typically `v1.4.0`; `package.json.version` is `1.4.0`.
  `semver` is not a current dependency — use a small local compare or add it to
  deps; either way the comparator must reject non-semver strings rather than
  silently mis-parse them.)
- `checkLatestVersion(opts): Promise<VersionCheckResult>`:
  - Resolves installed version.
  - **Cache first, network second.** Stat `data/cache/latest-release.json`. If it
    exists and is younger than `TTL_MS` (1 hour), return it without a network
    call. This also de-risks the multi-worker race below: a fresh cache already
    present means a sibling worker already fetched.
  - If no fresh cache, **take the lock** (see §3.2) before fetching, so only one
    worker hits the GitHub API when several boot together.
  - On a miss, calls the GitHub Releases API:
    `GET https://api.github.com/repos/anjasta-tarigan/yggdrasil/releases/latest`
    with header `User-Agent: yggdrasil` (GitHub requires it; anonymous quota is
    60 req/hour/IP). The request carries an **explicit timeout**
    (`UPDATE_CHECK_FETCH_TIMEOUT_MS`, default 5000ms) via `AbortController` /
    `AbortSignal.timeout`. A hung connection is aborted and handled exactly like a
    network error (see §5), and the lock is released in the `finally` block so a
    stalled fetch cannot hold the lock open.
  - Compares `normalizedSemver(latest)` > `normalizedSemver(installed)` →
    `available`.
  - Writes the result **atomically**: serialize to a temp file and `rename()`
    onto `data/cache/latest-release.json` (never a direct write — a half-written
    file from a concurrent writer would otherwise be read as corrupt by siblings;
    the `rename` is atomic on POSIX). A corrupt/partial cache file on read is
    treated like a cache miss (re-fetch) rather than a hard error.
  - **Channel signal.** A `main`-channel build is detected by an explicit build
    marker, not merely by a failed semver parse: prefer an env var the installer/
    build sets (e.g. `YGGDRASIL_CHANNEL=main`) or `git describe` output, falling
    back to "not a clean semver" only when no marker is present. When the marker
    says `main`, return `{ available: false, channel: "main", ... }` — never
    "available". This avoids a dev build like `0.0.0-dev` (valid semver)
    wrongly triggering the release-update badge.
  - **Error policy (unified):**
    - Network error, malformed API body, or corrupt cache on read → treat as a
      cache miss and (under lock) attempt a fresh fetch; if that also fails,
      return `{ available: false, errored: true }` and warn. Never throw to the
      startup caller.
    - **403 rate-limit** (`x-ratelimit-remaining: 0`, or a 403 with a rate-limit
      body): if any cache file exists (even past TTL), return its stored result
      with `errored: true`; if no cache file exists at all, return
      `{ available: false, errored: true }`. A rate-limited response is **never**
      treated as a fresh "up to date" result.
- `VersionCheckResult` shape:
  ```ts
  {
    current: string;
    latest: string | null;
    available: boolean;
    channel: "release" | "main";
    releaseUrl: string | null;   // HTML release page, not the API URL
    releaseNotes?: string | null; // plain text, truncated, NOT raw HTML
    checkedAt: number;
    errored: boolean;
  }
  ```
- `fetch` is injected in tests (no real network in CI).

### 3.2 `src/lib/bootstrap.ts` (modify) + worker coalescing
- At the end of bootstrap, fire-and-forget:
  ```ts
  version.checkLatestVersion().catch((e) =>
    syslog("warn", "update-check", `startup check failed: ${e}`)
  );
  ```
  Must not block or delay server readiness.
- **Cross-worker coalescing.** In production the server runs multiple Node
  workers that boot near-simultaneously; without coordination each would fetch
  GitHub on first boot, burning the 60 req/hour/IP anonymous quota. Use a
  process-level sidecar lockfile (the `O_EXCL` sidecar pattern already proven in
  `src/lib/ai/provider-config/store.ts:67`) around the network fetch:
  - **Stale-lock guard.** Before attempting `O_EXCL`, `stat(cache.lock)`. If it
    exists and its mtime is older than `LOCK_STALE_MS` (e.g. 2× the 5s fetch
    timeout = 10s), a prior owner died holding it (crash/OOM-kill/forced
    restart). Unlink it and retry the `O_EXCL` once. Without this, a leftover
    lock would make every future worker permanently skip the network call.
  - If another live worker holds the lock (the `O_EXCL` fails), the loser does
    **not** skip silently. It waits up to `LOCK_WAIT_MS` (e.g. 3000ms), polling
    the cache file every ~100ms for the winner's result. Only after that window
    with no fresh cache does it return `{ available: false, errored: true }` — a
    safe, *expected* transient state on cold-start of multiple workers; callers
    treat `errored: true` as "unknown", not "up to date".
  - The lock is released (`unlink`) in a `finally` block after the atomic
    `rename` of the cache file, or on any error/timeout. Because the fetch is
    bounded by `UPDATE_CHECK_FETCH_TIMEOUT_MS`, the lock cannot be held longer
    than that window plus the stale threshold.
  - The cache stat-check in §3.1 means a worker that boots after the winner has
    written the file simply reads the fresh cache and never contends.

### 3.3 `src/app/api/system/update-check/route.ts` (new)
- **Guard.** This route is consistent with the other management/settings routes:
  `GET` and `POST` both run under the same origin/loopback guard the project
  applies to settings endpoints (the listener is `127.0.0.1`-bound; remote
  callers must present `APP_SECRET`). `GET` exposes no secrets (only installed
  version + update status), but it is guarded for parity and to prevent unguarded
  enumeration of deployment state. The data is **not** sensitive.
- `GET` → calls `checkLatestVersion()`, reads the `system_update_dismissed`
  setting, and returns:
  ```ts
  {
    current, latest, available, channel, releaseUrl,
    dismissed: dismissedVersion === latest,   // per-release dismiss
    releaseNotes?: string,                      // plain text, truncated
  }
  ```
  `releaseNotes`, if populated from the GitHub release body, is returned as
  **plain text (truncated)** — never raw HTML. The Settings UI renders it as
  text/sanitized markdown and must **not** use `dangerouslySetInnerHTML`.
- `POST` (body `{ action: "dismiss" }`) → writes
  `{ version: latest, dismissedAt: Date.now() }` under key
  `system_update_dismissed` via `setSettingsDb`. Uses the same guard pattern as
  other mutating settings routes.

### 3.4 `src/components/settings/UpdateCheck.tsx` (new) + settings panel (modify)
- Fetches `GET /api/system/update-check` on mount.
- If `available && !dismissed`: render a badge
  "Update v{latest} available — view" linking to `releaseUrl`, plus a
  "Dismiss" button → `POST` → re-fetch.
- If `!available`: render nothing (or a subtle "up to date" line, optional).
- Dismiss is stored per-release (see §4), so a newer release re-shows the badge.

### 3.5 `src/cli/commands/check-update.ts` (new) + `src/cli/index.ts` (modify)
- `yggdrasil check-update [--dir <dir>]`:
  - Calls `checkLatestVersion({ appDir })` directly (no server needed).
  - Prints: installed version, latest version, and "Update available: vX" or
    "Up to date (vX)".
  - Exit codes: `0` = up to date; `1` = update available; `2` = check failed
    (network/parse). This makes it usable from a cron script or shell alias.
- Register `check-update` in the CLI subcommand table alongside `install`,
  `update`, `status`, `uninstall`.

## 4. Data Model — Dismiss State

Stored in the existing `settings` table (same pattern as `system_persona`):
- key: `system_update_dismissed`
- value: `{ version: string, dismissedAt: number }`

The API compares `dismissed.version` to the current `latest`. If they differ
(the release moved forward), `dismissed` is `false` and the badge returns. This
prevents a single dismiss from hiding all future updates.

## 5. Error Handling & Edge Cases

The error policy is centralized in `checkLatestVersion` (§3.1). Summary:

- **Network / API failure** → `available: false`, `current` still correct, no
  badge, startup unaffected (the bootstrap call catches and warns).
- **Rate-limit (403 / `x-ratelimit-remaining: 0`)** → if a cache file exists (any
  age), return its stored result with `errored: true`; if no cache file exists at
  all, return `{ available: false, errored: true }`. A rate-limited response is
  **never** treated as a fresh "up to date" result, and never triggers a retry
  storm.
- **Malformed GitHub response / corrupt cache on read** → treat as a cache miss
  and (under lock) attempt a fresh fetch; if that also fails, `available: false,
  errored: true`.
- **`main`-channel install** → detected by an explicit build marker (env var or
  `git describe`), not by semver-parse failure; returns `channel: "main"`,
  `available: false`. A dev build with a valid semver (e.g. `0.0.0-dev`) does
  **not** trigger a false "update available".
- **Cache write permission denied** → warn and continue; the in-memory result is
  still returned. The caller is never blocked by a failed cache write.
- **CLI errors** → exit code `2`, message to stderr, never throws unhandled.

## 6. Testing

- **version.ts** (mock `fetch`):
  - semver compare (patch/minor/major newer; equal; older), with `v` prefix
    stripped from `tag_name` before compare.
  - cache hit (fresh file) avoids network; cache miss calls network.
  - **rate-limit (403 + `x-ratelimit-remaining: 0`)**: with a stale cache file →
    returns the cached result with `errored: true`; with no cache file →
    `{ available: false, errored: true }`. Assert no "up to date" false positive.
  - malformed body → `available: false, errored: true`.
  - corrupt cache file on read → behaves like a miss (re-fetch), does not throw.
  - cache file **atomic write** (temp + rename): simulate a concurrent partial
    writer is out of scope, but assert the written file is valid JSON and that a
    subsequent read returns the same result.
  - **cache write permission denied** → warns, returns result, does not throw.
  - `main` channel (marker present) → `channel: "main"`, `available: false`; a
    `0.0.0-dev` build with valid semver → not flagged as a spurious release.
  - CLI (`--dir`) and server resolve the **same** cache path.
  - lockfile coalescing: two concurrent calls → only one network fetch.
  - **stale lock recovery**: a pre-existing `cache.lock` older than
    `LOCK_STALE_MS` is unlinked and the fetch proceeds (does not deadlock).
  - **lock loser fallback**: when the lock is held by a live worker and no cache
    exists yet, the loser waits up to `LOCK_WAIT_MS` then returns
    `{ available: false, errored: true }` rather than hanging.
  - **fetch timeout**: a hung GitHub connection is aborted at
    `UPDATE_CHECK_FETCH_TIMEOUT_MS` and released in `finally`; the lock is freed.
- **API route**:
  - `GET` returns the documented shape with a mocked `checkLatestVersion`; both
    `GET` and `POST` reject an unguarded remote caller (loopback/secret).
  - `POST dismiss` writes `system_update_dismissed`; subsequent `GET` returns
    `dismissed: true` for that version; a newer `latest` flips it back.
  - `releaseNotes`, when present, is plain text and is not raw HTML.
- **CLI `check-update`**: mocked fetch → assert exit code (`0`/`1`/`2`) and
  stdout/stderr content.
- No real network calls in CI — `fetch` is always mocked.

## 7. Security Notes

- The feature only *reads* a public GitHub endpoint; it never downloads or
  executes code. The only write it performs is the local dismiss flag.
- The GitHub call uses an explicit `User-Agent` and honors 403 rate-limits; it
  does not log tokens or secrets.
- No new process listens, no scheduled timers, no external egress beyond the one
  GitHub GET at most once per hour (cached).

## 8. Non-Goals / Follow-ups

- Auto-update / one-click update from the UI (requires the existing
  `update` command's backup+rebuild, gated behind explicit confirmation).
- `main`-channel update signaling.
- Background periodic polling.
