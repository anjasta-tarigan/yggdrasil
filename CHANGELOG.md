# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Changed

- Tailwind now scans the installed Streamdown plugin bundles so their styles are included in generated CSS.
- Anti-slop feedback now labels heuristic style flags without implying a factual accuracy score, and the scanner flags repeated substantive sentences.
- System prompts now prioritize direct, non-repetitive answers and evidence-based web research with source citations and explicit uncertainty.

### Added

- Built-in Exa and Firecrawl search settings accept multiple API keys, rotate
  them round-robin, and cool down rejected or rate-limited keys independently.
  Stored key values remain server-side; the Settings UI only receives key IDs.
- MCP server authentication can be managed after setup. Optional API keys are
  available for manually configured servers, and OAuth is offered only when
  the server publishes valid OAuth protected-resource and authorization-server
  metadata.

### Security

- MCP OAuth state now expires after ten minutes, is checked in constant time,
  and can only be consumed once per app process. Token callbacks validate the
  registered server and never return provider error bodies to the browser.
- Disconnecting or removing an MCP server clears its stored OAuth tokens and
  expiry metadata.

### Changed

- MCP servers can be selected as the primary `web_search` or `web_fetch`
  provider. The selected MCP implementation uses the canonical tool name,
  with a built-in fallback when its arguments can be mapped; other released
  duplicates keep server-prefixed names.

### Security

- MCP web results are marked as untrusted, size limited, and configurable web
  requests use SSRF-safe fetching with redirects disabled for credentialed APIs.

### Fixed

- **System prompt metadata no longer leaks into Windows requests.** The prompt
  loader now parses CRLF YAML frontmatter, and the invariants clarify that
  Yggdrasil's current tools and their results define available capabilities.
- **Memory vectors are isolated by provider endpoint and model.** sqlite-vec
  synchronization and the fallback RAG scan now reject vectors tagged for a
  different embedding source, and the fallback keeps only the nearest 50 hits
  per memory tier in memory.
- **Embedding rebuilds retain old vectors and report unfinished work.** Stale
  vectors count as pending after provider failures, and the Settings dialog
  stays open until every row is embedded with the selected model.
- **Standalone embedding endpoints retain their selected protocol.** Settings
  now explicitly distinguishes Ollama from OpenAI-compatible endpoints, so
  Ollama works on custom ports and its model list/probe use the right API.
- **Database diagnostics report sqlite-vec only when the active connection can
  create a `vec0` table.** This fixes detection on Windows builds that omit
  `vec_version()`. The documented reranker default now matches its opt-in gate.
- **Windows shell tools use PowerShell.** Their command guardrails now cover
  destructive PowerShell operations and timeouts kill the process tree.
- **Settings modal responsive layout hydrates consistently.** Mobile breakpoint
  detection now runs after hydration so server and initial client markup match.
- **Monospace font token no longer references itself**, allowing the configured
  JetBrains Mono font to resolve through Tailwind's `font-mono` utility.
- **Embedding settings now describe offline behavior accurately.** Memories
  remain text-searchable and are backfilled when the embedding endpoint returns.
- **Development server no longer inherits production mode or port from the
  installed app's environment file.** `pnpm dev` now runs in development mode
  on Next.js's default dev port, alongside the installed service.
- **POSIX installation uses production mode from dependency installation onward.**
  The development-only mode is selected by the dev command, not the install
  environment template copied into an installed app.
- **Windows CLI commands use pnpm.cmd for updates and honor `--dir` for service
  controls.** Node cannot spawn pnpm's Windows command shim directly; update now
  runs it through `cmd.exe`, and start/stop/restart/status/logs resolve the
  requested install directory.
- **Windows service startup uses the executable pnpm shim and reports launch
  failures.** Select a CRLF-clean `.cmd` path from `where.exe`, stop the generated
  launcher on `Start-Process` errors, and hide only its child window so
  `yggdrasil start` leaves the caller's terminal visible.
- **PowerShell installer no longer closes the caller's terminal.** The documented
  `irm ... | iex` flow now returns from the installer script block on success and
  reports failures as terminating errors instead of calling `exit` on the host.
- **Windows startup under restricted PowerShell defaults.** Launch the generated
  background script with a process-scoped execution-policy override, without
  changing the user's or machine's persistent policy.
- **Windows service registration fallback.** If Task Scheduler denies access,
  install and start Yggdrasil for the current user and launch it again at sign-in
  through the user's Startup folder. This path does not require administrator access.
- **Windows installation and release publishing.** Invoke Next.js through its
  `build` command, limit clean builds to one worker, safely launch the build
  through PowerShell, and avoid release-guard shell parsing of commit JSON.
- **Installer CI coverage.** Run Windows PowerShell parsing and build-command
  path checks on CI and before release asset publishing.

### Added

- **New `GGUF Model` provider** — run local `.gguf` chat models through a
  Yggdrasil-managed `llama-server` (fixed port 2301) with OOM-safe resource
  planning, idle auto-unload, and an "Add GGUF Model" flow in Settings →
  Providers. Place `.gguf` files in `data/models/GGUF-chatModel/`; install the
  server with `curl -LsSf https://llama.app/install.sh | sh`.
- **Enterprise CI/release pipeline.**
  - `ci.yml` — a merge gate that runs `tsc --noEmit`, `eslint`, the unit suite,
    and a POSIX + PowerShell syntax check of both installer scripts on every PR
    and push to `development`, so a broken installer can never reach `main`.
  - `publish-installer.yml` — re-publishes the four installer assets
    (`install.sh`, `install.sh.sha256`, `install.ps1`, `install.ps1.sha256`) to
    the latest GitHub release on every merge into `main`, with a release-merge
    guard so it never races `release.yml`. New installs therefore always run the
    freshest merged `main` code.
  - `release.yml` strengthened into a full release gate (type-check + tests +
    installer validation) that publishes the installer assets on every `v*`
    tag push, sharing a concurrency group with `publish-installer.yml`.
- **GGUF resource section** on provider cards: displays the computed
  llama-server CLI flags (context, KV dtype, threads, batch, idle timeout,
  GPU layers) using the same memory-budgeting planner the runner uses, with
  real-time status (running / standby / stopped) and Start/Stop controls.
  The plan and status are fetched through new server-side endpoints
  (`/api/gguf/plan`, `/api/gguf/server`) so the client bundle stays free of
  Node.js built-ins.
- **`mapGgufHealth()`** in `service-status.ts` — maps `RunnerStatus` (running
  → "running", standby → "standby", unload → error label or "llama-server
  not installed") to the shared `ServiceHealth` vocabulary, mirroring the
  existing `mapEmbeddingHealth`/`mapRerankerHealth` pattern. The mapped
  `health` object is attached to the `GET /api/gguf/server` response
  alongside the raw runner status.
- **llama-server status in `/api/health`** — the `"gguf"` service aggregates
  the best lifecycle state across all GGUF-model providers' models and reports
  it in the `SystemHealth.services` payload.
- **Server path picker** in the Add GGUF Model dialog — lets users probe a
  specific `llama-server` binary location for non-PATH installs.
- **Env-gated integration test** `gguf-server.integration.test.ts` — spawns a
  real `llama-server` (gated on `LLAMA_TEST_BINARY` + `LLAMA_TEST_MODEL`) to
  validate flag planning, `/health` + `/v1/models` contract, and an OpenAI
  `/v1/chat/completions` round-trip.

### Fixed

- **Hardened the Windows installer (2026-10-21).** TLS setup now works with
  Windows PowerShell 5.1, pnpm discovery checks common install paths before
  failing, and build log paths containing apostrophes no longer break the build
  command.
- **Windows install no longer gets stuck.** `APP_SECRET` is now generated by
  `yggdrasil seed-env` and verified (64-hex) **before** the production build, so
  `next build` can no longer abort on a missing-secret `ZodError` and leave the
  install hanging. A hung `next build` is now bounded by a wall-clock timeout
  (`YGGDRASIL_BUILD_TIMEOUT`, default 1800s) that kills the whole pnpm → node
  tree and fails loudly instead of hanging forever.
- **Default installs now track `main`, not the frozen release tag.** The
  checksum-verified `irm …/install.ps1 | iex` and `curl …/install.sh | bash`
  paths resolve the latest release only to verify the installer, then check out
  `main` (the latest merged `development`) unless `YGGDRASIL_VERSION` is
  explicitly pinned — so merged fixes reach new installs immediately.
- **Installer line endings are normalized to LF** in `.gitattributes`, removing
  cross-platform CRLF/LF drift that could trip the SHA-256 verification gate.
- **LlamaRunner `stop()` now clears `this.planned` and `this.child`**, so stopped
  servers correctly report `state: "unload"` (not `"standby"` with a stale PID)
  in `/api/gguf/server` status responses. Previously, `stop()` killed the child
  process and cleared the pidfile but left `planned` and `child` references in
  place, causing the status getter to surface a dead PID and a stale plan.
- **Exit listener removed after successful health check.** `pollHealth()` now
  calls `child.removeAllListeners("exit")` once the server is confirmed healthy,
  preventing a post-startup crash (within the 10s `CRASH_WINDOW_MS`) from
  triggering the spawn-time crash-loop retry path. The idle-timer and explicit
  `stop()` continue to manage the post-startup lifecycle.
- **`readyResolve`/`readyReject` cleared after `pollHealth()`** resolves or
  rejects, preventing stale promise references from lingering beyond a single
  spawn cycle.
- **`VERSION_RE` regex hardened against false-positive version matches.** The
  bare `b` alternative in `src/lib/llama/detect.ts` could match any 'b' followed
  by 3-5 digits in arbitrary text (e.g. `"sub12345"`). Changed to `(?<=^|\s)b(?=\d)`
  requiring a word boundary before 'b', while preserving the short-form `"b7488"`
  format used by older llama.cpp builds.
- **"Start now" button in GgufResourceSection is now functional.** Previously
  `handleStart` was a no-op (only cleared the error state). It now sends `POST
  /api/gguf/server` with `action: "start"`, mirroring `handleStop`.
- **Status polling in GgufResourceSection now actually refetches.** The 2s
  interval now increments a `refreshKey` consumed by `useGgufStatus`, causing
  the status `useEffect` to re-fetch instead of just calling `forceUpdate({})`
  on a stale response.
- **`getDefaultModel()` now rejects `gguf-model` defaults for background jobs.**
  A GGUF-model set as the default would auto-spawn `llama-server` via
  `chatModelForEntry → ensureGgufServerRunning` whenever unattended cognitive
  jobs (`reflect_turn`, `sleep_consolidation`) resolved the default model,
  holding the server (and its RAM) alive for the idle-timeout window. This
  mirrors the existing `web-session` rejection guard with a user-actionable
  error pointing to Settings → Providers. Manual chat routes remain unaffected.
- **Build error: `onnxruntime_binding.node` in client bundle.** The GGUF
  resource section in the settings UI imported `getAvailableMemoryBytes`
  from `@/lib/system-stats`, which transitively pulled in
  `onnxruntime-node` (a native addon) into the browser client bundle,
  breaking the build. The memory function has been extracted to a new
  lightweight `@/lib/system-memory` module with zero heavy dependencies,
  and all importers (`runner.ts`, `detect.ts`, `tabs.tsx`) now import from
  it.
- **Turbopack error: client component importing Node.js built-ins.** The
  `GgufResourceSection` in the settings UI imported `node:os`, `node:fs/promises`,
  `node:path`, `@/lib/llama/runner`, and `@/lib/llama/detect` directly into a
  `"use client"` component, causing Turbopack to fail with "the chunking context
  (unknown) does not support external modules (request: node:fs)". The resource
  planning and server status checks now go through new API endpoints
  (`/api/gguf/plan` and `/api/gguf/server`) so the client bundle stays free of
  Node.js built-ins.
- **GGUF provider now follows foreign-port reassignments.** When `llama-server`
  could not bind the default port 2301 because a *foreign* healthy server held
  it, the runner already reassigns to a free port and persists the new
  `baseUrl` to the registry — but the chat and durable-model paths rebuilt the
  AI SDK provider from the *stale* in-memory `entry.baseUrl`, pointing requests
  at the foreign server on 2301. `chatModelForEntry` and `buildDurableModel`
  now build from the `baseUrl` **returned** by `ensureGgufServerRunning` (the
  runner's SSoT), so a reassigned provider is never shadowed by a stale
  `entry.baseUrl`.
- **Foreign-port reassign now triggers on any healthy foreign port, not only
  on a `/props` mismatch.** A foreign server on 2301 whose `/props` happened to
  name the *same* model file was neither adopted (no pidfile claim) nor
  reassigned — it fell through to a doomed spawn on the occupied port. Since
  `tryAdopt` already claims the legitimate-or-orphan path (pidfile claim +
  `/health` + `/props` match) and returns early, a healthy port reached in
  `spawnAndAwait` is by definition a server we did not spawn: the runner now
  reassigns unconditionally in that branch.

## [0.3.4] - 2026-10-18

### Fixed

- **Windows `pnpm build` now works.** The `build`/`dev`/`build:ci` npm scripts
  used POSIX inline-env syntax (`NEXT_TELEMETRY_DISABLED=1 TURBOPACK_WORKERS=1
  next build`). npm runs lifecycle scripts under `cmd.exe` on Windows, which has
  no `VAR=value command` form, so the build aborted with
  `'NEXT_TELEMETRY_DISABLED' is not recognized as an internal or external command`
  and the installer failed at the `pnpm build` step. These scripts now delegate
  to small Node wrappers (`scripts/build.mjs`, `scripts/dev.mjs`) that set the
  env vars in-process and spawn `next`, so the build succeeds on Windows and
  POSIX alike without any new dependency (keeping `install.ps1`'s frozen
  lockfile intact).

- **Windows scheduled-task registration is now robust to paths with spaces.**
  The `schtasks /Create` command was built as a single quoted string and run
  through `cmd.exe /c`, whose backslash-escaping mangles `\"` and splits the
  `/TR` argument at the first space. For any non-default install directory (e.g.
  `C:\My Apps\yggdrasil`) the task's `-File` path was truncated and the service
  silently never started at logon. `generateWindowsTaskCommand` now returns an
  `argv[]` array passed verbatim to `schtasks` (no `cmd.exe` wrapper), with the
  script path single-quoted so PowerShell accepts spaces. `installService` also
  resolves `pnpm`'s absolute path at install time and embeds it in
  `start-background.ps1`, so the limited logon session no longer depends on
  inheriting a PATH that includes pnpm's shim directory. Task creation now throws
  (and fails the install) on `schtasks` error instead of silently continuing.

- **Windows service status is now locale-independent.** `WindowsManager.status()`
  previously parsed the localized `schtasks /Query` "Running" string, so on a
  non-English Windows it always reported inactive and `start()` could spawn a
  duplicate `next start` on port 2302. It now prefers pidfile liveness via
  `tasklist` (a numeric PID, language-agnostic), falling back to `schtasks` only
  when no pidfile exists yet.

- **Windows installer can no longer wipe the user PATH.** Root cause: `bin.test.ts`
  ran the real `install`/`uninstall` commands against a temp `--dir` and redirected
  `HOME` (so the POSIX symlink stayed in temp) but never isolated the Windows
  registry. On Windows, `addPathToWindowsUserPath`/`removePathFromWindowsUserPath`
  write the real `HKCU\Environment\Path`, so running the suite appended — and on
  an interrupted run replaced — the developer's actual PATH with a temp dir, wiping
  their environment. Fixes: (1) both PATH functions plus `broadcastEnvChange` now
  short-circuit whenever `VITEST` is set, so no registry write happens under test;
  (2) a data-loss guard refuses any write that would *shrink* the existing PATH
  (a sign the read was truncated and a naive write would clobber it); (3) a new
  regression test asserts the real registry PATH is byte-for-byte unchanged across
  an add+remove pair under test. As a result, `yggdrasil install`/`uninstall` can
  no longer destroy existing PATH entries.

- **Installer now repairs a stale `.env` instead of trusting it.** Root cause:
  `writeEnvFile` skipped secret generation whenever `~/.yggdrasil/.env` already
  *existed*. After a previous botched install the file could be empty or missing
  `APP_SECRET`, so the server booted with no secret (and, without `PORT`, fell
  back to Next's default port 3000). The installer now merges managed keys
  (`APP_SECRET`, `NODE_ENV=production`, `PORT`) into the existing file and always
  (re)generates a valid 64-hex `APP_SECRET`, preserving any user-managed keys.

- **Service no longer inherits a non-standard `NODE_ENV` from the environment.**
  Next.js refuses to override an already-set process env var with a `.env` value,
  so a user profile exporting a non-standard `NODE_ENV` leaked into the server and
  triggered Next's "non-standard NODE_ENV" warning. The Windows `start-background.ps1`
  (and systemd `Environment=`, launchd `EnvironmentVariables`) now forcibly set
  `NODE_ENV=production` and load the canonical `.env` before launching `pnpm start`,
  so the service always runs with a valid secret and production mode regardless of
  the ambient environment. The launchd plist also now uses POSIX paths (previously
  `path.join` emitted Windows backslashes on a Windows build host, producing an
  unparseable `/Users/...` → `\Users\...` path).

- **Installer now self-heals a prior broken clone and restarts a stale service.**
  Root cause of repeated "refs/tags/X is not a commit" + detached-HEAD installs:
  the project publishes *annotated* tags, so `git clone --branch <tag>` aborts and
  leaves a partial `.git`; a later re-run reused that contaminated repo and never
  converged. Both `install.ps1` and `install.sh` now (1) detect a corrupt local
  `.git` and wipe it before cloning, (2) resolve a tag to its commit SHA via the
  GitHub commits API and clone by SHA (annotated tags dereference correctly), and
  (3) verify `HEAD` equals the expected commit, failing loudly instead of silently
  detaching. Separately, `yggdrasil install` now **restarts** an already-active
  service rather than letting the idempotent `start()` early-return — otherwise the
  stale process kept serving the old, secret-less state (the "APP_SECRET is
  required" / non-standard-NODE_ENV symptom) even after a fresh `.env` was written.

- **Installer now self-verifies `APP_SECRET` and `pnpm dev` loads `.env`.**
  A broken `.env` from an earlier botched install could persist across later
  installs that failed *before* reaching secret generation, so the server kept
  booting without `APP_SECRET` and throwing the cryptic ZodError. Hardening:
  `writeEnvFile` now re-reads what it wrote and throws a clear, actionable error
  (naming `~/.yggdrasil/.env`) if a valid 64-hex `APP_SECRET` did not land, so a
  broken install is never reported as success. Separately, `scripts/dev.mjs` now
  loads the install's `.env` into the dev server's environment (matching the
  production service), so `pnpm dev` no longer silently runs without `APP_SECRET`
  — the most common path that produced the "next dev" runtime error. The
  production-missing-secret ZodError message is also now actionable.

- **Secret is now seeded BEFORE `pnpm build` (Fixes: "auto generate app secret
  never works").** Root cause: both installers ran `pnpm build` *before*
  `yggdrasil install`, and the secret is only generated inside that later step.
  `next build` evaluates `src/env.ts` (`envSchema.parse(process.env)`); under
  `NODE_ENV=production` with no `APP_SECRET` it throws the ZodError and the build
  aborts *before* `writeEnvFile` ever runs — so the secret was "never generated."
  Fix: a new `yggdrasil seed-env` CLI command (reusing `writeEnvFile`, the single
  source of truth) seeds `~/.yggdrasil/.env` with a valid `APP_SECRET` and links
  `app/.env`. Both `install.ps1` and `install.sh` now (1) copy `.env.example` to
  `.env` right after clone, then (2) call `seed-env` immediately after
  `pnpm install` and before `pnpm build`, guaranteeing a valid secret for the
  build and the service. Verified end-to-end: `seed-env` produces a 64-hex
  `APP_SECRET` and an `app/.env` symlink/copy.

- **Windows installer no longer reports false success.** `install.ps1` previously
  printed the "installation complete" banner unconditionally, so a failed
  `pnpm build` or CLI handoff looked identical to a success and the terminal
  closed with no signal. Each stage (dependency install, build, CLI installer)
  is now checked; any failure prints a `YGGDRASIL INSTALLATION FAILED` banner
  and exits non-zero, and `exit 0` is reachable only on full success. Added a
  Windows-only OS guard that routes Linux/macOS users to `install.sh` before any
  download.

- **Windows service manager is now idempotent and orphan-free.**
  `WindowsManager` (`src/cli/platform/windows.ts`) no longer spawns a second
  instance when already running (`start()` is a no-op when active), and
  `stop`/`uninstallService`/`restart` now kill the live `pnpm`→`node` process
  tree via `taskkill /PID /T /F` before ending the scheduled task — eliminating
  zombie processes and the duplicate `next start` port-2302 conflict.

### Added

- **Windows CLI on PATH (shipped).** Commit `0cd6414` added Windows
  user-PATH registration (registry `HKCU\Environment\Path`) and a
  `yggdrasil.cmd` wrapper so the `yggdrasil` command works from any new
  terminal, but it landed *after* the `v0.3.3` tag and was never released. This
  release finally ships it — `yggdrasil` is now recognized on Windows after
  install. (Also shipped: the `install.ps1` completion banner with service URL,
  data/logs paths, and a note to reopen the terminal for PATH to take effect.)

## [0.3.3] - 2026-10-18

### Fixed

- **Nested transaction handling after `node:sqlite` migration:** the compat
  layer's `.transaction()` and Drizzle's `NodeSqliteSession.transaction()`
  now share a single transaction-depth tracker (`txDepthMap`), so nested
  calls use savepoints instead of attempting a second `BEGIN`. Previously
  calling a compat-layer transaction inside a Drizzle transaction raised
  "cannot start a transaction within a transaction". This fixes the unit
  test failure in `memory-managers.test.ts`.

## [0.3.2] - 2026-10-18

### Changed

- **Migrated from `better-sqlite3` to `node:sqlite` (Node.js built-in):** replaced
  the native C++ addon (which required Visual Studio Build Tools on Windows) with
  Node.js's built-in `node:sqlite` module (`DatabaseSync`), available since Node
  v22.5.0 and required on Node >= 24.0.0. A custom sync Drizzle adapter
  (`src/db/node-sqlite-adapter.ts`) bridges `DatabaseSync` to Drizzle's
  `SQLiteSyncDialect`, providing the `.transaction()`, `.prepare()`, and
  `.pragma()` semantics that `better-sqlite3`'s API provided. The compat layer
  (`src/db/compat.ts`) adds `.pragma()` and `.transaction()` to `DatabaseSync`
  for backward compatibility with existing raw-SQL call sites. Removed
  `better-sqlite3` and `@types/better-sqlite3` from `package.json`, removed the
  `allowBuilds.better-sqlite3` entry from `pnpm-workspace.yaml`, and removed
  `better-sqlite3` from `serverExternalPackages` in `next.config.ts`. Updated
  `install.ps1` to require Node >= 24.0.0 (matching `install.sh` and
  `package.json` engines), fixing the mismatched version check.

### Fixed

- **GGUF Model add flow:** Clicking "Add GGUF Model" now opens a working
  dialog that probes for `llama-server` via `/api/gguf/status`, shows an
  install banner (with link to https://llama.app/ and copyable `curl`
  script) when the binary is absent, scans `data/models/GGUF-chatModel/`
  for `.gguf` files, and lets the user select model(s) to add. Selected
  models are created as a `gguf-model` provider entry on port 2301 with
  `displayName` derived from the filename stem. The `toWriteInput`
  serializer no longer drops the `gguf` settings block.
- **`isProviderConfig` now recognizes `"gguf-model"` providers**, so they
  are no longer silently stripped from the client cache on save/hydration.
  Previously GGUF providers persisted on the server but were invisible in
  the UI.
- **GGUF dialog error handling:** network/HTTP failures during the status
  probe are now surfaced as an error message instead of silently showing
  the install banner as if the binary were missing. The confirm step
  catches server rejections and displays them in-dialog rather than
  throwing an unhandled rejection. AbortController guards prevent
  `setState` after unmount.
- **`llama-server` detection now falls back to the `llama` binary** on
  PATH. The `llama.app` installer ships a unified `llama` binary (with a
  `serve` subcommand) rather than a standalone `llama-server`, so
  previously-installed binaries were not detected. The version regex now
  also matches the `build N` format used by the unified binary.
- **Model directories auto-created on startup:** `data/models/GGUF-chatModel`
  and `data/models/embedding` are now created by the instrumentation hook
  on first boot, so users can drop `.gguf` files without manual `mkdir`.
- **Fixed GGUF model directory path**: `modelsDirPath()` now resolves to
  `data/models/GGUF-chatModel` (previously `data/GGUF-chatModel`, missing
  the `models` subdirectory), matching the user-facing instructions in the
  dialog and the actual directory layout.
- **GGUF dialog footer now shows llama-server status**: build version
  with a green dot when detected, yellow dot when detected but version
  unparseable, red dot when the binary is not found.
- **Settings dialog footer now shows system status**: system operational
  (daemon running), embedding health, and reranker status with colored
  status dots, placed below the tabs in the main Settings dialog.
- **Windows install now works**: `bin/yggdrasil.mjs` previously imported the
  CLI entry with a bare `C:\…` path, which Node's ESM loader rejects on
  Windows with `ERR_UNSUPPORTED_ESM_URL_SCHEME` — aborting the whole install,
  since both `install.sh` and `install.ps1` finish by running that wrapper.
  The entry is now imported via a `file://` URL, so the install CLI runs on
  Windows as it already did on Linux/macOS.
- **Windows background service uses the resolved install path**: the Windows
  service manager hardcoded `%USERPROFILE%\.yggdrasil` and relative
  `..\data\logs` redirects, so the scheduled task pointed at the wrong
  directory and `start-background.ps1` failed when launched from a non-app
  CWD (e.g. system32 at logon). It now derives every path from the resolved
  `InstallPaths`, matching the systemd and launchd managers, so custom-directory
  installs and the default install both start correctly.

## [0.3.0] - 2026-09-30

### Added

- **GGUF model provider:** New provider kind backed by a Yggdrasil-supervised
  `llama-server` child process. Users download `.gguf` files from HuggingFace
  and place them in `data/models/GGUF-chatModel/`. Yggdrasil spawns and
  supervises llama-server on port 2301 with OOM-safe resource planning
  (thread clamping to cores-1, KV cache limits, crash-loop protection,
  idle-timeout shutdown). The provider integrates as a keyless OpenAI-compatible
  endpoint, mirroring Ollama's handling. Settings UI shows an "Add GGUF Model"
  button and a "GGUF" badge. `chatModelForEntry` is now async and ensures the
  server is running before constructing the provider.

## [0.2.18] - 2026-09-30

### Added

- **Database reset:** The Settings → Database tab now has a "Reset database"
  action (behind a confirmation dialog) that permanently erases all
  conversations, memories, project sessions and queued jobs, reclaims the
  space with VACUUM, and returns per-table counts. Settings, API keys,
  providers, plugins and cron schedules are preserved; trusted projects must
  be re-authorized.
- **Storage maintenance:** Settings → Database now offers "Optimize planner"
  (`PRAGMA optimize`, fast and safe any time) and "Optimize + VACUUM"
  (reclaims free disk pages). Planner optimization also runs automatically
  inside the daily deep sleep sweep, with a weekly VACUUM on Sundays.
- **Query diagnostics:** Settings → Database now shows maintenance operation
  timings parsed from the system log (total/slow/avg/max, slow = >100ms),
  and `POST /api/maintenance/diagnostics` runs `EXPLAIN QUERY PLAN` for a
  single caller-supplied SELECT (writes rejected) to support slow-query
  inspection.
- **Settings modal overlay:** The Settings panel is now a large centered modal
  with a two-pane layout (vertical icon navigation on desktop, horizontal
  scrollable nav on mobile) overlaid on a dimmed/blurred backdrop. The chat
  remains mounted and visible behind the overlay. A close-guard blocks dismissal
  during active SSE rebuild and prompts for confirmation before discarding
  unsaved drafts.
- **Project harness auto-trust setting:** A new "Project Harness Auto-Trust"
  toggle in Settings → General automatically trusts all project directories,
  eliminating manual trust approval prompts for shell commands and file writes.
  Destructive operations (delete, git restore/checkout, etc.) and QnA operations
  still require approval via the tool-approval policy, preserving safety.
- **MCP server authentication flow:** MCP servers from the marketplace that
  declare OAuth or API key auth now prompt for credentials during installation
  via a dedicated auth dialog. OAuth opens an authorization URL in a new tab
  and polls for completion; API key prompts for a header name and value. Auth
  credentials are stored in the encrypted secret store (chmod 600), never in
  the SQLite settings JSON. The `McpServerConfig` type now includes an `auth`
  field tracking method, status (`not_configured`/`configured`/`needs_refresh`),
  OAuth scopes, and last-authenticated timestamp. Connection time overlays
  stored tokens onto the transport (Authorization header for HTTP/S, env vars
  for stdio).

### Changed

- **Build memory optimization:** Disabled source map generation in production
  builds (`productionBrowserSourceMaps: false`), eliminating ~300-500MB of
  memory overhead with no runtime impact. Enable via
  `ENABLE_SOURCE_MAPS=true` if needed.
- **Build memory optimization:** Set `TURBOPACK_WORKERS=1` as the default for
  the `build` script to avoid spawning parallel Turbopack workers that each
  consume 200-400MB. The `build:ci` script retains auto-parallel workers for
  high-RAM CI environments.
- **Build memory optimization:** `install.sh` now clears stale `.next` and
  `.turbo` caches before building, preventing memory eviction pressure from
  stale cache entries.
- **Build memory optimization:** Excluding dev-only packages (vitest,
  @testing-library/*, drizzle-kit) from the production bundle via
  `serverExternalPackages`, preventing ~400-600MB of unnecessary bundling.

### Fixed

- **MCP OAuth secret key scheme mismatch:** OAuth callback route now stores
  tokens keyed by `serverId` (from the HMAC-signed state token) instead of
  `serverName` (display name), matching the resolution scheme used by
  `overlayAuthCredentials` and `resolveSecretsIntoConfig` in the MCP manager.
- **MCP API key secret key scheme mismatch:** API key secrets are now stored
  with the `mcp_${config.id}_${apiKeyName}` prefix instead of bare key names,
  matching the `overlayAuthCredentials` resolution scheme.
- **MCP OAuth token expiration checking:** `overlayAuthCredentials` now reads
  the stored `token_expires_at` secret and, when the access token is expired,
  attempts to refresh it using the stored refresh token via `refreshOAuthToken`.
- **SSRF vulnerability in OAuth dynamic client registration:** The start route
  now wraps the dynamic client registration `fetch()` call with `secureFetch()`
  and `assertSafeUrl()` guard.
- **MCP OAuth polling memory leak:** The `McpAuthDialog` now clears `setInterval`
  and `setTimeout` timers on unmount via `useEffect` cleanup with `stopPolling()`.
- **MCP OAuth polling stale closure:** The 5-minute timeout now reads from
  `busyRef.current` instead of a stale render-time `busy` capture.
- **MCP OAuth polling silent error swallowing:** Poll errors are now tracked
  via `consecutiveErrorsRef` and surfaced to the user after 3 consecutive
  failures instead of being silently swallowed.
- **MCP auth-dialog postMessage wildcard origin:** The OAuth complete route
  now uses `window.location.origin` instead of `"*"` as the `postMessage`
  target origin.
- **MCP marketplace detail env_vars auth method:** Servers declaring
  `env_vars` auth are no longer silently dropped; they are correctly mapped
  to the `"none"` auth method.
- **MCP auth-dialog poll function reference ordering:** Fixed a TypeScript
  error where `pollServerStatus` was referenced in a `useEffect` before its
  `useCallback` declaration.
- **Settings dirty-guard misses ONNX dimension changes:** The `isDirty` check
  in `SettingsView` now correctly tracks embedding dimension changes for the
  ONNX provider, preventing silent loss of unsaved work when closing the
  settings dialog.
- **Settings snapshot fetch deferred:** `SettingsView` no longer fires a
  `GET /api/settings` request on mount when the dialog is closed; the fetch
  is gated on `open` and re-runs when the dialog is opened.
- **Harness Auto-Trust event listener:** `HarnessAutoTrustCard` now listens
  for the `yggdrasil:harness-auto-trust-changed` custom event (dispatched by
  `saveHarnessAutoTrust`) instead of the `storage` event, which never fired
  for server-side saves.
- **Duplicate image results in chat:** Multiple `image_search` tool calls in a
  single assistant message now render as a single consolidated gallery with
  deduplication by image URL. Previously, each `image_search` call produced its
  own `ImageGallery` component, leading to duplicate thumbnails and separate
  dialog popups when calls returned overlapping results. Hover effects and
  interactions are now isolated per thumbnail instead of syncing across
  duplicated galleries.
- **Reranker no longer activates by default:** `RERANKER_ENABLED` now defaults
  to `false` instead of `true`, so the ONNX reranker session is not
  pre-warmed or searched for model files unless the user explicitly opts in.
- **Reranker model path configuration:** Additionally, all hardcoded references to
  `bge-reranker-v2-m3-int8.onnx` (`CANONICAL_MODEL_PATH`,
  `DEFAULT_RERANKER_FILENAME`) have been removed; the reranker model path must
  now be configured entirely by the user via
  `RERANKER_MODEL_PATH` or by placing a model in `data/models/reranker/` and
  selecting it in Settings.

## [0.2.17] - 2026-09-29

### Fixed

- **Settings modal centered on desktop:** Replaced `md:static` (which broke
  floating positioning) with `md:inset-auto md:top-1/2 md:left-1/2
  md:-translate-x-1/2 md:-translate-y-1/2` so the dialog is properly
  centered as an overlay instead of falling into normal document flow.
  Also added `translate-x-0 translate-y-0` to the mobile classes to
  prevent Radix's base translate transforms from pushing the fullscreen
  dialog off-screen on mobile.
- **Settings modal blur overlay:** Removed the duplicate `<DialogOverlay />`
  rendered in `SettingsView` (DialogContent already renders one internally),
  and lowered the overlay `z-index` from `z-50` to `z-40` so it sits behind
  the dialog content. The overlay now correctly shows a dimmed, blurred
  background instead of full black.
- **Settings modal layout on desktop:** Restructured the Tabs layout to use
  `flex flex-col h-full min-h-0` with `md:flex-row` on the Tabs root so the
  sidebar stretches to full height and the header renders above content.
  Previously the Tabs container lacked a flex-column-to-flex-row breakpoint,
  and the sidebar `TabsList`'s `h-full` was overridden by the
  `group-data-vertical/tabs:h-fit` rule hardcoded in the `tabs.tsx` base
  (higher specificity than the consumer's plain utility). The `TabsList` base
  no longer forces a height, so the sidebar's plain `h-full` stretches the
  tablist across the full dialog height without `!important`.
- **Settings modal content rendered wider than the dialog (Reranker tab):**
  `DialogContent` is a CSS grid with a single auto track, and the track was
  sized by the Tabs root's min-content contribution (wide `<pre>`/URL content
  → ~1227px). The pane therefore laid out ~331px wider than the 896px dialog
  and `overflow-hidden` clipped text mid-line (toggle/buttons pushed past the
  edge). Fixed by adding `min-w-0` to the Tabs root so its minimum
  contribution to the track is 0, clamping the track to the dialog width;
  `overflow-x-hidden` on the scroll container remains as paint-level defense
  for wide `<pre>` blocks. Verified all 8 tabs report zero pixels past the
  dialog edge with the sidebar still full height.
- **Settings sidebar menu items oversized and spaced too far apart:** Each
  `TabsTrigger` inherits `flex-1` from the tabs base (needed for equal widths
  in horizontal mode), which in the vertical sidebar stretched every item to
  ~70px — `flex-basis: 0%` + `grow: 1` override the intended `h-9`. Added
  `flex-none` so items render at their content height (36px) with the designed
  4px gap between them, and set an explicit `w-56` (224px) panel width in
  place of the base `w-fit`, which had sized the panel to its content.
- **Settings sidebar menu vertically centered instead of top-aligned:** The
  tabs base carries `justify-center`, which in the column sidebar centered the
  menu block in the middle of the panel. Added `justify-start` so items run
  normally from the top downward (`General` sits directly under the panel's
  top padding).
- **Settings modal mobile tab strip clipped:** The strip's `h-auto` was
  overridden by the `group-data-horizontal/tabs:h-8` rule hardcoded in the
  `tabs.tsx` base, pinning the strip to 32px while its own `p-3` padding and
  36px triggers needed ~60px — nav items collapsed into an unusable 8px-tall
  scroll region. The base no longer forces heights (the standard horizontal
  strip height is set explicitly as `h-8` by its consumers), so the settings
  strip sizes to its content.
- **Settings modal first tabs unreachable on mobile:** The mobile `TabsList`
  inherited the base `justify-center`; with 8 labels (~600px) overflowing a
  ~375px container, flexbox centered the row past the start edge and
  `scrollLeft` cannot go negative — `General` and part of `Persona` were
  permanently clipped and unscrollable. Added `justify-start`.
- **Settings modal capped at 448px on tablet-width viewports:** The
  `DialogContent` base's `sm:max-w-md` survived tailwind-merge (unprefixed
  `max-w-*` classes don't dedupe a variant-scoped one), so on 640–767px
  viewports the fullscreen dialog was capped at 448px and anchored to the
  left edge instead of filling the screen. Added a same-modifier
  `sm:max-w-none` override.

## [0.2.5] - 2026-09-28

### Changed

- The assistant "warming up" placeholder no longer shows the bouncing dots.
  It now cycles through varied shimmering status phrases (Thinking it
  through…, Gathering context…, …) so an idle first response still reads as
  alive, while keeping the shimmer sweep.
- Available updates now surface in the header notification center (the Events
  inbox), not only the About-tab banner (banner removed).

### Fixed

- The shimmer sweep animation used `repeat: Number.POSITIVE_INFINITY` without an
  explicit `repeatType`, which could render as a non-looping static fade. Set
  `repeatType: "loop"` so the shimmer sweep (used by both the warming-up
  placeholder and the reasoning "Thinking" label) animates continuously.

- **Project file explorer was broken:** Only dotfiles appeared because one
  huge dependency directory (`.venv`) consumed the 5000-entry quota before root
  entries like `src/`, `tests/`, `README.md` were reached. Fixed by removing
  the mid-walk truncation and adding depth-first sorting with per-directory
  fairness caps so shallow/root entries always survive.

- File panel now supports manual width adjustment via drag-to-resize on the
  left border edge (minimum 150px, default 300px).

## [0.2.4] - 2026-09-28

### Fixed

- The Statistics page "System logs" tab showed nothing: the log viewer's
  `GET`/`DELETE`/download endpoints under `/api/system/logs` did not exist and
  every request 404'd. The endpoints are now implemented over the existing
  log store. They had never shipped because `.gitignore` had a bare `logs/`
  pattern that matched at any depth and silently excluded
  `src/app/api/system/logs/`; it is now anchored to the repo root.

## [0.2.3] - 2026-09-28

### Fixed

- Tool approvals had no Accept/Deny control for built-in tools, so a call
  paused at "Awaiting approval …" (e.g. `manage_subagent`) and the turn hung
  with no way to proceed. A tool in `approval-requested` was rendered by the
  non-interactive tool-call trail; it is now always rendered by the
  confirmation card, which carries the buttons.

## [0.2.2] - 2026-09-28

### Fixed

- `yggdrasil update` failed at the build step on every installed instance
  because Turbopack statically traced filesystem calls whose paths resolve
  under `data/`, followed the installed `app/data` symlink out of the app root,
  and aborted with "Symlink [project]/data/... is invalid, it points out of the
  filesystem root". A fresh install was unaffected because `install.sh` builds
  before creating the symlink. The affected calls now carry the codebase's
  `turbopackIgnore` marker, and a static guard test catches any future omission.

## [0.2.1] - 2026-09-28

### Fixed

- Running `yggdrasil` from any directory other than the app root failed with
  `ERR_MODULE_NOT_FOUND: Cannot find package '@/lib'`. tsx resolved
  `tsconfig.json` relative to the current directory, so the `@/*` path alias
  was unresolved when the CLI was invoked through the `~/.local/bin/yggdrasil`
  symlink. The launcher now pins `TSX_TSCONFIG_PATH` to the app tsconfig.

## [0.2.0] - 2026-09-28

### Added

- `http_request` built-in tool: a generic SSRF-guarded outbound HTTP client (the
  `curl` equivalent) for REST/JSON APIs, webhooks, and raw-protocol requests,
  with a choice of method, headers, and body. Mutating methods (POST/PUT/PATCH/
  DELETE) require user approval; response bodies are framed as untrusted data.
- `conversation_search` built-in tool: literal keyword search over past
  conversation messages, complementing the semantic `memory_search`. The
  current chat is excluded by default.
- Subagent capability grants expanded beyond web/memory/sandbox/tasks to include
  `image_search`, `file_operations`, `notify_user`, `host_info`, and device
  `location`.
- Prompt protocols documenting long-term memory, `file_operations`,
  `conversation_search`, `http_request`, and skill usage.

### Changed

- **Unified `file_operations` into a single implementation**
  (`lib/ai/tools/file-operations-core.ts`), shared by the built-in chat tool,
  the project-harness fallback, and the durable workflow step. The three
  historical copies had silently drifted (one supported `jump`, another an
  overwrite guard, another carried a `$&`-substitution bug); they now behave
  identically.
- The built-in `file_operations` tool is scoped to a dedicated chat workspace
  (`data/workspace`, override via `YGGDRASIL_WORKSPACE_DIR`) instead of
  `process.cwd()`, which pointed at the Yggdrasil install tree in production.

### Fixed

- `file_operations` `edit` no longer treats `$&`, `$$`, `` $` `` and `$'` in
  the replacement string as substitution patterns — the harness fallback and
  durable step now use a replacer function like the built-in tool, so written
  code is byte-exact.
- `file_operations` `find` accepts glob-style patterns (e.g. `*.ts`): fd was
  receiving them as a regex and erroring out, returning no matches.
- `file_operations` creates its workspace directory on first use, so a fresh
  install no longer fails with an ENOENT from `realpath`.
- Destructive-tool approval now covers `remove`, `purge`, `reset`, `clear`,
  `terminate`, `revoke`, `wipe`, and `truncate` verbs, plus irreversible shell
  mutations (`git restore`, `git checkout -- <path>`, `find -delete`, `xargs rm`,
  `truncate`, `shred`).
- `manage_skill` mutations (create/update/delete) now require user approval:
  a skill body is injected into the system prompt on later turns, making it a
  persisted instruction surface like MCP servers and custom tools.

## [0.1.9] - 2026-09-27

### Fixed

- **Installer/update build failure.** `next build` collected page data with
  parallel workers, each importing `@/db` and running additive schema migrations
  against the same live database. The non-atomic check-then-`ALTER` let two
  workers race, and the loser aborted the build with
  `SqliteError: duplicate column name: active_stream_id`. The migration now runs
  inside a single `BEGIN IMMEDIATE` transaction and tolerates the duplicate
  column if another connection still wins.
- Importing `@/db` no longer opens or migrates the database. The SQLite client
  is created on first use, so a production build is side-effect-free and never
  mutates the user's data while bundling.
- Silence Turbopack "Dynamic filesystem access causes tracing of the whole
  project" warnings for the installer/uninstall, project-service, sandbox, and
  project-harness filesystem calls.

## [0.1.8] - 2026-09-27

### Fixed

- `yggdrasil uninstall` now performs a complete cleanup: removes the PATH export
  block it added to the shell profile, deletes the PID file, and clears
  platform-specific remnants.

## [0.1.7] - 2026-09-27

### Changed

- Polished the installer UI with TTY-gated formatting, panel output, and
  progress reporting.

## [0.1.6] - 2026-09-26

### Security

- Neutralized third-party address and memory text against prompt block-forging.

## [0.1.5] - 2026-09-26

### Fixed

- Kept the original update error visible when rollback steps fail, instead of
  letting a secondary rollback failure mask the real cause.

## [0.1.4] - 2026-09-26

### Fixed

- Stopped the `data` symlink from blocking `yggdrasil update`.

## [0.1.3] - 2026-09-26

### Added

- `yggdrasil check-update` command, a system update-check API endpoint, and an
  UpdateCheck component in the settings About tab.
- Passive update check during startup.

### Fixed

- Coalesced update fetches under the lock, isolated tests, and persisted the
  channel marker.
- Kept the `Content-Type` check outside the Bearer CSRF bypass.

## [0.1.2] - 2026-09-26

### Fixed

- Generated `APP_SECRET` on install by dropping the env-schema import from the
  CLI path.
- Pinned the installed code to the verified release tag.

## [0.1.1] - 2026-09-25

### Fixed

- Refused HTTP and TLS downgrades when fetching the installer.
- Linked `.env` into the app root so `APP_SECRET` loads at runtime.
- Repaired the release workflow (Node floor, route typegen, pnpm version).

## [0.1.0] - 2026-09-25

### Added

- Initial release: autonomous cognitive system, resumable chat streams,
  projects, plugins/skills, web providers, and the `yggdrasil` installer CLI.

[Unreleased]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.2.5...HEAD
[0.2.18]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.2.17...v0.2.18
[0.2.5]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/anjasta-tarigan/yggdrasil/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.1.0
