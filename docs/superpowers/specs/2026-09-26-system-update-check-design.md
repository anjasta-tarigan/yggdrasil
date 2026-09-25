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
- `checkLatestVersion(opts): Promise<VersionCheckResult>`:
  - Resolves installed version.
  - If installed version is not a valid semver (e.g. a `main` channel build),
    returns `{ available: false, channel: "main", ... }` — never "available".
  - On a cache hit (file `data/cache/latest-release.json` younger than 1 hour)
    returns the cached comparison without a network call.
  - On a miss, calls the GitHub Releases API:
    `GET https://api.github.com/repos/anjasta-tarigan/yggdrasil/releases/latest`
    with header `User-Agent: yggdrasil` (GitHub requires it; anonymous quota is
    60 req/hour/IP).
  - Compares `semver(latest)` > `semver(installed)` → `available`.
  - Writes the result to memory + `data/cache/latest-release.json` (TTL 1h).
  - On any failure (network, 403 rate-limit, malformed body) returns
    `{ available: false, errored: true }` and logs a warning. Never throws to the
    caller in the startup path; the API path surfaces `errored`.
- `VersionCheckResult` shape:
  ```ts
  {
    current: string;
    latest: string | null;
    available: boolean;
    channel: "release" | "main";
    releaseUrl: string | null;   // HTML release page, not the API URL
    checkedAt: number;
    errored: boolean;
  }
  ```
- `fetch` is injected in tests (no real network in CI).

### 3.2 `src/lib/bootstrap.ts` (modify)
At the end of bootstrap, fire-and-forget:
```ts
version.checkLatestVersion().catch((e) =>
  syslog("warn", "update-check", `startup check failed: ${e}`)
);
```
Must not block or delay server readiness.

### 3.3 `src/app/api/system/update-check/route.ts` (new)
- `GET` → calls `checkLatestVersion()`, reads the `system_update_dismissed`
  setting, and returns:
  ```ts
  {
    current, latest, available, channel, releaseUrl,
    dismissed: dismissedVersion === latest,   // per-release dismiss
    releaseNotes?: string,                      // optional, truncated
  }
  ```
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

- **Network / API failure** → `available: false`, `current` still correct, no
  badge, startup unaffected.
- **Rate-limit (403 / `x-ratelimit-remaining: 0`)** → treat as unknown; reuse
  older cache if present, else assume up-to-date. No retry storm.
- **Malformed GitHub response** → assume up-to-date, warn.
- **`main`-channel install** → version is not valid semver → `channel: "main"`,
  `available: false`. No false "update available".
- **CLI errors** → exit code `2`, message to stderr, never throws unhandled.

## 6. Testing

- **version.ts** (mock `fetch`):
  - semver compare (patch/minor/major newer; equal; older).
  - cache hit avoids network; cache miss calls network.
  - rate-limit (403 + ratelimit header) → `available: false, errored: true`.
  - malformed body → `available: false`.
  - `main` channel → `channel: "main"`, `available: false`.
  - cache file written to `data/cache/` and reused within TTL.
- **API route**:
  - `GET` returns the documented shape with a mocked `checkLatestVersion`.
  - `POST dismiss` writes `system_update_dismissed`; subsequent `GET` returns
    `dismissed: true` for that version; a newer `latest` flips it back.
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
