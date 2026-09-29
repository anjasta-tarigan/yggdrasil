# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  Additionally, all hardcoded references to `bge-reranker-v2-m3-int8.onnx`
  (`CANONICAL_MODEL_PATH`, `DEFAULT_RERANKER_FILENAME`) have been removed; the
  reranker model path must now be configured entirely by the user via
  `RERANKER_MODEL_PATH` or by placing a model in `data/models/reranker/` and
  selecting it in Settings.

### Added

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
