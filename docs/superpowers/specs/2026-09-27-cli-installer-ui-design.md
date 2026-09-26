# Design Specification: Polished Non-Interactive CLI Installer UI

**Date:** 2026-09-27  
**Status:** Implemented  
**Scope:** Terminal output presentation layer only — no interactivity added; installer remains non-blocking under `curl | bash`.

---

## 1. What This Changes (and What It Doesn't)

| Old behavior                                          | New behavior                                              |
| :---------------------------------------------------- | :-------------------------------------------------------- |
| Linear log lines like `[Yggdrasil] Setting up…`       | Banner + checkmarks, step timing, status panel            |
| No progress feedback on health poll                   | Spinner line that clears on completion                    |
| Generic footer text                                   | Boxed panel with URLs, data paths, and optional features  |
| Error messages leak to stderr                         | Color-coded status lines only when TTY is present         |

No new prompts, no interactive flags, no blocking on redirected output. The same commands (`install`, `update`, `uninstall`) keep their exact semantics and exit codes.

---

## 2. Presentation Goals

1. **Modern professionalism** — a single-line banner, colored icons for success/fail, consistent monochrome fallback.
2. **Information density without noise** — each step shows name + detail + elapsed time in seconds or milliseconds.
3. **Actionable opt-ins** — web search & ONNX notes reference env vars plus the web UI ("Settings → Tools"), not code paths.
4. **TTY gating** — ANSI colors and spinners vanish when stdout is redirected (CI, systemd journal capture, `yggdrasil install > f`).

---

## 3. Architecture

### 3.1 Module Boundary: `src/cli/utils/format.ts`

A small helper module with **no backend imports**, no `@/env`, no app schema. Exports:

- `formatDuration(ms): string` — human times (ms/s/m).
- `step(label, detail?, elapsedMs?): void` — checkmark + info.
- `success(message): void` — one-line confirmation.
- `warn(message): void` — yellow warning to stderr.
- `heading(text): void` — blue arrow header.
- `panel(title, rows[]): void` — key/value boxed panel.
- `withSpinner(label, work): Promise<T>` — spinner around any async task.
- `colorEnabled(): boolean` — TTY detection.

All ANSI sequences are guarded by `colorEnabled()`: when false (non-TTY), every renderer returns plain text. This keeps logs readable and avoids polluting CI artifacts.

### 3.2 Command Integration: `src/cli/commands/install.ts`

The installation flow remains identical; every `console.log("[Yggdrasil] …")` is replaced with formatted helpers:

```ts
import { heading, step, success, warn, panel, withSpinner } from "../utils/format";
```

Key changes:
- `heading("Yggdrasil installer — $baseDir")` prints the top banner.
- `prepareDirectories` → `step("Preparing directories", "5 dirs under $dataDir", ms)`.
- `writeEnvFile` now always chmods `providers.secrets.env` early so a pre-existing file gets corrected permissions even if `.env` exists.
- `waitForHealth` runs inside `withSpinner` with an animated ticker.
- Closing `summaryPanel` renders the info box in two themes depending on whether the service started successfully:
  - Healthy: `"URL http://localhost:PORT"` and `"Status healthy"`
  - Skipped/Timed out: `"Start yggdrasil start"` and `"Status pending"`

Optional-feature rows show env var names plus the web UI path ("Settings → Tools" or "post-install restart") so users know how to proceed.

### 3.3 Cleanup: `src/cli/utils/paths.ts`

Three helper functions originally swallowed all exceptions via `console.debug`:

- `ensureSecurePermissions`, `ensureSymlink`, `addPathToProfile`

These were updated to suppress **only ENOENT** (the expected "doesn't exist yet" cases during a fresh install) while re-exposing anything else (`EACCES`, `EISDIR`). A shared `isNotFound(err)` guard prevents noisy probe warnings in redirection scenarios.

---

## 4. Visual Specs

### 4.1 Banner

```
⟢ Yggdrasil installer — /home/u/.yggdrasil
```

Blue left-arrow (`⟢`) + bold title. Plain text under redirect.

### 4.2 Step Lines

```
✔ Preparing directories  5 dirs under /home/u/.yggdrasil/data (4ms)
✔ Environment file  generated APP_SECRET, mode 600 (3ms)
✔ Linking data & env  app/data, app/.env, git exclude (2ms)
✔ CLI on PATH  /home/u/.local/bin (1ms)
✔ Background service  skipped (--no-service)
```

Green checkmark (✔), step name, detail, duration. Details are optional; time is always human-readable.

### 4.3 Health Poll

On a TTY:

```
… health check on http://localhost:2302/api/health (8s)
```

Single-line ticker updates every second, cleared before returning to checkmark or failure. Under redirect: just waits silently.

### 4.4 Summary Panel

Boxed layout with border rules and two columns aligned to longest value:

```
┌ ──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Yggdrasil installed                                                                          │
├ ──────────────────────────────────────────────────────────────────────────────────────────────┤
│ Start yggdrasil start                                                                        │
│ Data  /home/u/.yggdrasil/data                                                                │
│ Logs  /home/u/.yggdrasil/data/logs                                                           │
│                                                                                                │
│ Optional — configure after install:                                                          │
│   Web search  EXA_API_KEY | FIRECRAWL_API_KEY | SEARXNG_BASE_URL,                            │
│               or Settings → Tools in the web UI                                              │
│   ONNX model  drop bge-reranker-v2-m3-int8.onnx                                              │
│               into /home/u/.yggdrasil/data/models/reranker (≥50 MB, then yggdrasil restart)  │
└ ──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Border color: blue. Content is white in TTY; plain ASCII under redirect. The panel's first row adapts to service state (URL vs start command).

---

## 5. Error Handling & Failures

- Errors inside `withSpinner` propagate unchanged; spinner is cleared regardless of outcome.
- Warnings emit to stderr with an "▲" indicator: `▲ Service started but health check timed out after 30s. Check logs at $logsDir`.
- The spinner's ANSI escape codes never appear in non-TTY output, so pipes retain plain text: `… health check on http://... (7s)`.

---

## 6. Tests

A new unit test suite at `src/cli/__tests__/format.test.ts` pins behavior without inspecting ANSI escapes:

- `formatDuration` thresholds (ms, s, m)
- Step outputs match expected strings, with no escape codes on non-TTY
- Panel borders align uniformly regardless of content length
- `withSpinner` resolves/rejects cleanly and leaves no timer behind

Existing integration tests (`bin.test.ts`, `bootstrap.test.ts`) pass unchanged except for a banner-text assertion (`install --help`, `install --dir …`) that required updating to the new `heading` string.

All 42 CLI tests pass sequentially (`--maxWorkers=1` per Rule 18).

---

## 7. Dependencies Added

No new external packages. `format.ts` uses only Node.js builtins:

- `process.stdout.isTTY` — TTY detection
- `NO_COLOR` env respect (if set, colors disabled universally)

This keeps the installer lean and zero-build overhead.

---

## 8. Future Work (Out of Scope)

- Interactive prompts for provider/API keys can be layered later as a separate `/config` command.
- Progress bars for build steps could use `cli-progress` or similar; current design omits them for minimalism.
- Rich log follow (`yggdrasil logs -f`) may reuse the same TTY gate and spinner logic.

---

## 9. Compliance Checklist

✅ Minimal edits per Rule 16 (single concern: output formatting)  
✅ No silent error suppression — ENOENT probes ignored, others exposed  
✅ Memory safety (timer cleanup in `withSpinner`, no leaks)  
✅ Type-safe across helpers; TSC `--noEmit` clean  
✅ Anti-slop: no boilerplate comments, no filler verbs, no redundant logging  
✅ Non-interactive guarantee preserved under all conditions (Rule 22 §3)  
