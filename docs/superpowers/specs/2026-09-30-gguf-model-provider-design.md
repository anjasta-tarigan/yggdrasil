# GGUF Model Provider — Design Spec

**Date:** 2026-09-30
**Status:** Revised after review (awaiting implementation plan)
**Author:** Claude (brainstorming session with Anjasta)

**Revision history:**
- 2026-09-30 (r2): review fixes — param-count KV tiers, fit-based dtype/context
  ordering, `idleMinutes` optional in schema, `modelId` threaded into the server
  hook, pidfile-based orphan handling, stderr-parsed flag fallback, version-gate
  formats, fit-aware model sorting, `gguf.contextWindow` clarification, env-gated
  integration test.

---

## Problem

Ollama's GGUF provider works but takes too long for models to become active — Ollama
loads the full model weights into memory on each request, with no warm-start or
resource-tuned startup. Users running GGUF models locally need a provider that:

1. Starts fast (process stays warm between requests).
2. Uses hardware-appropriate resource limits (no OOM, no wasted RAM).
3. Requires no manual server management (fully managed by the app).

## Solution

A new provider kind, `gguf-model`, backed by llama.cpp's native `llama-server`.
Yggdrasil spawns `llama-server` as a supervised child process, tunes its flags
from the device's hardware profile and the selected model's size, and exposes it
as a standard OpenAI-compatible endpoint — so the existing AI SDK integration
works unchanged.

Users place `.gguf` model files in `data/models/GGUF-chatModel/` (same workflow
as ONNX embedding models). The app scans that directory, lets the user select a
model, and manages the server lifecycle on demand.

---

## Architecture

```
Settings → Providers → "Add GGUF Model"
   │  scans data/models/GGUF-chatModel/*.gguf
   │  detects llama-server binary (PATH + configurable path)
   ▼
Provider registry entry:
  { kind: "gguf-model",
    baseUrl: "http://127.0.0.1:2301",
    models: [{ modelId: "Qwen2.5-7B-Instruct-Q4_K_M.gguf" },
             { modelId: "Phi-3-mini-4k-instruct-q4.gguf" }] }

Chat request targeting GGUF provider + model
   ▼
ensureGgufServerRunning(entry, modelId)   ← new hook, called before generation
   │  modelId IS the .gguf filename; resolves to data/models/GGUF-chatModel/<modelId>
   │  (with a path-traversal guard: modelId must equal its own basename)
   ▼
LlamaRunner, keyed by `${providerId}:${modelId}` (src/lib/llama/runner.ts)
   ├─ ensureRunning(): server up with THIS model? → spawn llama-server
   │                   (planned flags) → poll /health → verify /props model path
   ├─ touch(): reset idle timer on each request
   ├─ model switch (different modelId, same provider): stop old, start new
   └─ idle timeout → SIGTERM → standby
   ▼
createOpenAICompatible({ baseURL, dummy key })   ← existing provider.ts path
```

A `gguf-model` provider entry may carry **multiple model entries** (one per
`.gguf` file), mirroring how an Ollama provider lists many models under one
entry. The runner serves one model at a time (single-slot server); switching
`modelId` restarts the child with the new file.

### New modules

All live under `src/lib/llama/`:

| Module | Responsibility |
|---|---|
| `resource-planner.ts` | Pure function: device specs + model file → CLI args. Fully unit-testable. |
| `runner.ts` | Child-process supervisor: spawn, health-poll `/health`, crash-restart with backoff (max 3), idle timer, SIGTERM teardown, log capture to syslog. |
| `detect.ts` | Binary discovery (`llama-server` on PATH + configurable path) + `data/models/GGUF-chatModel/` directory scan. Version verification against a minimum. |

### No wire-protocol changes

`llama-server` serves `/v1/chat/completions` (OpenAI-compatible) out of the box.
`chatModelForEntry` and all downstream consumers remain unchanged — the only new
branch is `kind === "gguf-model"` alongside `kind === "ollama"` in provider
construction (dummy API key, `/v1` suffix handling).

---

## Resource planner — OOM-safety core

### Inputs

`cpuCores`, `totalMemBytes`, `freeMemBytes`, `modelSizeBytes`, model filename
(for parameter-count extraction), GGUF metadata (`capabilities.contextWindow`
from the model entry — informational only), settings overrides
(`gguf.contextWindow` — the user cap, see §Context derivation).

### Device profile (reuses `system-stats.ts`)

Already available: `os.cpus().length`, `os.totalmem()`. Free memory obtained at
call time via a dedicated read (not stale cache).

### Memory budget — absolute formula

```ts
usable = freeMemBytes - Math.max(GB(1.5), freeMemBytes * 0.30)

if (usable < GB(1.5)) {
  // Hard floor: insufficient for any meaningful model
  throw new LlamaResourceError(
    "Insufficient free memory for GGUF inference. Close other applications and retry."
  )
}

// Resident overhead, v1 approximation (see note below):
//   - 30% of model size: init-time weight touch + mmap page residency.
//     With mmap on (default) weights page in lazily, so the full file size
//     is NOT charged — a full-size charge is a warning, not a rejection.
//   - 512 MB fixed: llama.cpp context, sampler state, and compute buffers.
//     Compute buffers genuinely scale with batch × context, but without GGUF
//     header data (n_layer, n_embd) no exact term is computable; the fixed
//     term plus the conservative KV rates below cover observed cases.
//     Validated by the env-gated integration test (see §Testing plan).
const residentOverhead = modelSizeBytes * 0.30 + MB(512)

if (residentOverhead > usable) {
  throw new LlamaResourceError(
    `Model file (${formatBytes(modelSizeBytes)}) exceeds estimated usable memory ` +
    `(${formatBytes(usable)}). Try a smaller quantization.`
  )
}
```

### Tiered KV-cache estimate — by parameter count, not file size

File size is confounded by quantization (a Q8 7B ≈ 7.5 GB would share a bucket
with a Q4 14B ≈ 8 GB despite needing very different KV). Parameter count,
parsed from the filename, is the stable proxy:

```ts
// Matches "7B" in "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
// "1.5B" in "Qwen2.5-1.5B-Instruct-q4_k_m.gguf",
// "0.5B", "70B", "3B", "405B", ...
const PARAM_RE = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/

function paramsBillions(filename: string): number | null {
  const m = filename.match(PARAM_RE)
  return m ? parseFloat(m[1]) : null
}
```

Upper-bound per-token KV cost (f16), conservative for GQA/MQA architectures —
which cover all current-generation downloadable chat models (Qwen, Llama-3,
Mistral, Phi, Gemma). Legacy MHA models (e.g. Llama-2-7B-chat) may exceed these
by up to ~1.7×; that slack is absorbed by the 30 % / 1.5 GB system headroom
kept outside the budget, and by the crash-loop guard as a backstop:

| Params (from filename) | est KV/token (f16) |
|---|---|
| ≤ 2B | 0.10 MB |
| ≤ 9B | 0.30 MB |
| ≤ 15B | 0.50 MB |
| ≤ 35B | 1.00 MB |
| > 35B | 1.50 MB |
| unparseable (e.g. `Phi-3-mini-…`) | 0.60 MB (≤9B tier × 2 margin) + UI warning naming the file |

For `q8_0` KV cache, halve these values (q8_0 is near-lossless for KV).

```ts
function estKVPerToken(filename: string, modelSizeBytes: number, kvDtype: "f16" | "q8_0"): number {
  const params = paramsBillions(filename)
  const base =
    params === null ? 0.60 :
    params <= 2  ? 0.10 :
    params <= 9  ? 0.30 :
    params <= 15 ? 0.50 :
    params <= 35 ? 1.00 :
    /* > 35B */    1.50
  return kvDtype === "q8_0" ? base / 2 : base
}
```

### Context derivation — dtype follows the desired context, not the reverse

The planner preserves context first and spends KV precision second, since q8_0
is near-lossless while a shrunken context is a visible capability loss:

```ts
const kvBudget = usable - residentOverhead
const desired = Math.min(
  settingsOverride /* gguf.contextWindow */ ?? MODEL_DEFAULT_CTX /* 8192 */,
  modelCtxCap /* capabilities.contextWindow when known, else Infinity */,
)

function fits(ctx: number, kvDtype: "f16" | "q8_0"): boolean {
  return ctx * estKVPerToken(filename, modelSizeBytes, kvDtype) <= kvBudget
}

let kvDtype: "f16" | "q8_0"
let ctx: number

if (fits(desired, "f16")) {
  kvDtype = "f16"; ctx = desired            // ample headroom — best quality
} else if (fits(desired, "q8_0")) {
  kvDtype = "q8_0"; ctx = desired           // spend precision, keep context
} else {
  kvDtype = "q8_0"
  ctx = Math.floor(kvBudget / estKVPerToken(filename, modelSizeBytes, "q8_0"))
  if (ctx < 2048) {
    throw new LlamaResourceError(
      `Even q8_0 KV at minimum context (2048) exceeds memory. Pick a smaller model.`
    )
  }
  // ctx < desired: surface a warning so the user knows context was shrunk.
}
```

**Explicit policy:** `q4_*` KV types are **not used by default** — they cause
subtle quality degradation on long-context reasoning, and the user specifically
flagged side-effect concerns. `q4_0`/`q4_1` are available only via an advanced
override with an on-screen warning.

**Terminology (to avoid the earlier ambiguity):**
- `capabilities.contextWindow` (on the model entry) = model metadata:
  informational, the model's advertised/trained context. May be absent.
- `gguf.contextWindow` (on the provider entry's `gguf` block) = user override
  cap. When absent, the planner uses `MODEL_DEFAULT_CTX = 8192`.
- The planner's `ctx` is always `≤ min(override ?? 8192, known model cap)`
  and `≤ memory-derived max`.

### CLI flag derivation

| Flag | Value | Rationale |
|---|---|---|
| `-t` | `clamp(cores - 1, 2, 8)` | Leaves one core for the app; llama.cpp gains little past ~8 threads. |
| `-tb` | Same as `-t` | Prompt processing dominates; same budget. |
| `-np 1` | Fixed | Single chat slot; Yggdrasil serializes through one model. Unified KV. |
| `-c` | Derived above | Budget-constrained, never exceeds the model cap. |
| `-ngl 0` | Default | CPU-only v1. Manual `ngl` override exposed (labeled "manual only, no auto-detect"). |
| `-b` | `clamp(ctx / 8, 256, 1024)` | Scales with context; avoids oversized batches on small ctx. |
| `-ub` | `clamp(ctx / 16, 128, 512)` | Physical batch = logical / 2. |
| `-ctk` / `-ctv` | Derived above | f16 preferred; q8_0 when needed to preserve context. |
| `--cache-reuse 256` | On | KV-shifting prompt reuse — big win for agentic loops that resend the system prompt. |
| `--jinja` | On | Proper chat templates; required for tool calling on modern models. |
| `-fa on` | On (when supported) | Flash attention cuts KV memory; runner strips if unsupported (see §Fallback). |
| `--host 127.0.0.1` | Fixed | Never expose beyond localhost. |
| `--port 2301` | Default | User-chosen fixed port; reassigned only on foreign-port conflict (see §Ports). |

### Idle timeout — dynamic default

```ts
const modelSizeGB = modelSizeBytes / (1024 ** 3)
const defaultIdleMinutes = Math.min(15, Math.max(3, Math.round(modelSizeGB)))
```

Small models (≤3 GB) unload after 3 min; large models (≥15 GB) stay 15 min.
Configurable per provider via `gguf.idleMinutes`.

---

## Runner — lifecycle supervisor

### Ports

- Default port is **2301** (fixed, per user decision).
- The provider registry entry is written at creation time with
  `baseUrl: http://127.0.0.1:2301`.
- If 2301 is occupied **by a foreign server** at spawn time (health check
  responds but `/props` shows a different model), the runner picks a free port,
  persists the updated `baseUrl` to the registry entry, and spawns there.
  No foreign processes are ever killed — PID discovery across platforms
  (`lsof`/`ss`/netstat parsing) is out of scope.
- Our own orphans (spawned by a previous Node process that died without
  SIGTERM delivery) are handled via pidfile, below.

### Spawning

1. Plan flags via `resource-planner`.
2. Write pidfile `data/models/GGUF-chatModel/.llama-server.pid` with the child
   PID (best-effort; absent pidfile never blocks a fresh spawn).
3. Spawn `llama-server` as a child process (Node `child_process.spawn`, stdio
   piped to syslog and a tail buffer for UI error display).
4. Poll `GET http://127.0.0.1:<port>/health` every 500 ms (timeout 60 s for
   large-model first load).
5. On `{"status":"ok"}` → verify `GET /props` reports our model file
   (guards against adopting a foreign server on a reused port) → ready.

### Orphan adoption (startup)

1. If pidfile exists: `process.kill(pid, 0)` (portable existence check, no
   `lsof` needed). If alive **and** `/health` is ok **and** `/props` matches our
   model file → adopt (no respawn, zero TTFT). Otherwise delete the stale
   pidfile and spawn fresh.
2. If the port is held by a foreign healthy server → reassign port (see §Ports).
3. On app shutdown (`process.on('exit')`, SIGTERM/SIGINT handlers): SIGTERM the
   child, wait 10 s, SIGKILL, remove pidfile.

### Idle shutdown

- Every request calls `runner.touch()` which resets the idle timer.
- On expiry: SIGTERM → wait 10 s → SIGKILL, remove pidfile.
- Status transitions: `running → standby`.
- On next request: `standby → running` (re-spawn, same flags).

### Crash-loop guard

- If llama-server exits **non-zero within 10 s of spawn**, surface the last
  20 lines of stderr in the UI and stop retrying (no infinite restart loop).
- Max 3 restarts within a 5-minute window. After that, status → `unload` with
  an actionable error message.
- The unknown-flag retry below is exempt from the restart count (it is a
  planned single correction, not a crash loop).

### Unknown-flag fallback — stderr-parsed, bounded

If `llama-server` fails during startup argument parsing:

1. Scan the tail-buffered stderr for a token matching `--[a-z][a-z0-9-]*`
   on the error line (llama.cpp reports the offending flag, e.g.
   `error: unknown argument: --cache-reuse`).
2. If the token is in the **droppable set** — `--cache-reuse`, `-fa` /
   `--flash-attn`, `--jinja` — strip it and retry **once per flag**
   (max 3 retries total).
3. If the token is a **mandatory flag** (`-m`, `-c`, `--port`, `--host`, `-t`,
   `-b`, `-ub`, `-ngl`, `-ctk`, `-ctv`) → hard fail with the full stderr.
   A mandatory-flag failure indicates a broken binary, not a version skew.
4. If no flag token is found → hard fail with the full stderr.

---

## Detection — binary and model directory

### Binary discovery

```ts
function findLlamaServer(configuredPath?: string): { path: string; version: number | null } | null
```

1. If `configuredPath` is set and the file exists → use it.
2. Otherwise, scan `PATH` for `llama-server`.
3. If found, run `llama-server --version` (timeout 3 s). Parse **both** formats:
   - `version: 7231 (abc1234)` → `7231`
   - `b7488` → `7488`
   Regex: `/(?:version:\s*|b)(\d{3,5})/`. First capture group wins; if neither
   matches, `version = null`.
4. If `version !== null && version < MIN_LLAMA_SERVER_BUILD` → actionable UI
   error: *"llama-server build 1600 found, but build 6000+ is required for
   `--jinja` support. Update with `curl -LsSf https://llama.app/install.sh | sh`."*
   (`MIN_LLAMA_SERVER_BUILD = 6000`, ≈ mid-2025, postdates the `--jinja`
   introduction of Jan 2025. The exact constant is finalized at implementation
   time against the llama.cpp release history.)
5. If `version === null` (unparseable) → **warn and proceed**, not fail: the
   unknown-flag fallback (§Unknown-flag fallback) protects droppable flags at
   startup, so an unknown-but-working binary is never blocked by a parser gap.
6. If not found at all → `null`. UI shows the install banner.

### Model directory scan

```ts
function scanGgufModels(): Array<{ filename: string; path: string; sizeBytes: number; fitsMemory: boolean }>
```

- Scan `data/models/GGUF-chatModel/` (relative to project root).
- Return all `*.gguf` files.
- **Sort: fits-current-memory first, then by name** — largest-first would
  surface models that cannot run. `fitsMemory` is computed with the same
  `residentOverhead ≤ usable` check the planner uses (cheap: one `stat` +
  pure math per file, no spawn).
- If directory doesn't exist → return `[]` with a UI hint: *"Create the
  directory and place .gguf files there: `mkdir -p data/models/GGUF-chatModel`"*.

---

## Registry and schema changes

### Schema (`provider-config/schema.ts`)

```ts
// ProviderEntrySchema.kind — add to enum:
kind: z.enum(["openai-compatible", "ollama", "gguf-model", "web-session"])

// ProviderEntrySchema — optional gguf settings.
// NOTE: no Zod defaults inside this block. `idleMinutes` absent means
// "planner computes the dynamic default"; persisting happens only for
// explicit user overrides. A `.default(5)` here would shadow the dynamic
// default permanently, so it is deliberately omitted.
gguf: z.object({
  idleMinutes: z.number().int().min(1).max(60).optional(),
  contextWindow: z.number().int().min(2048).max(131072).optional(),
  ngl: z.number().int().min(0).max(100).optional(),
  kvDtype: z.enum(["auto", "f16", "q8_0"]).optional(),
  extraFlags: z.array(z.string().max(100)).max(10).optional(),
  serverPath: z.string().max(2048).optional(),
}).optional()
```

`gguf` block is optional on all providers; only meaningful when `kind === "gguf-model"`.
Effective values resolve as: user override → planner dynamic default
(`idleMinutes`: size-based; `ngl`: 0; `kvDtype`: fit-based `auto`).

### Provider instance (`provider.ts`)

```ts
// createProviderInstance — add branch:
if (entry.kind === "gguf-model") {
  return createOpenAICompatible({
    name: "gguf-model",
    baseURL: `${entry.baseUrl.replace(/\/$/, "")}/v1`,
    apiKey: "llamacpp",           // dummy, llama-server doesn't check
    supportsStructuredOutputs: true,
    fetch: sanitizeNonStreamJsonFetch,
  })
}

// chatModelForEntry — add pre-generation hook (modelId is available here):
if (entry.kind === "gguf-model") {
  await ensureGgufServerRunning(entry, modelId)   // starts server if needed
  // ... proceed to create provider + wrap model
}
```

### Model entries under a gguf provider

Each `modelId` = the `.gguf` filename (e.g. `Qwen2.5-7B-Instruct-Q4_K_M.gguf`).
`displayName` = filename stem (no `.gguf` extension).
`capabilities.contextWindow` = model metadata when known (else absent);
it caps but never enlarges the planner's `ctx`. `isDefault` = true only if the
user explicitly sets it.

---

## UI changes

### Settings → Providers — "Add GGUF Model" button

New button alongside "Add Ollama" and "Add OpenAI-compatible endpoint":

1. **Binary status row:**
   - ✅ `llama-server build 7231 found at /usr/local/bin/llama-server`
   - ❌ `llama-server not found — install with:` + copyable command:
     `curl -LsSf https://llama.app/install.sh | sh` + path picker for
     non-PATH installs.

2. **Model directory scan:**
   - List of `.gguf` files in `data/models/GGUF-chatModel/` with file size,
     fittable-first ordering, and a badge on files that exceed memory.
   - "No .gguf files found" + instructions to download from HuggingFace
     and place them in the directory.

3. User selects a model → creates provider entry + model entry.

### Provider card badge

`GGUF` badge (alongside existing `Ollama` / `OpenAI-compatible` badges) in the
providers list. Color: use the existing `Badge variant="outline"` pattern.

### Resource section (per-provider, advanced)

Shown when the provider is expanded:
- Computed flags (read-only display of what the planner chose, including the
  chosen KV dtype and any context shrink with its reason).
- Editable overrides: context cap, KV dtype, ngl (labeled "manual only,
  no auto-detect"), idle timeout, extra flags.
- "Start now" / "Stop now" buttons.

### Status footer

Reuse existing `ServiceHealth` vocabulary:

| State | `status` | `provider` label | Notes |
|---|---|---|---|
| Server running | `running` | `gguf-model` | Normal operation. |
| Server stopped (idle) | `standby` | `gguf-model` | Will restart on next request. |
| Binary not installed | `unload` | `llama-server not installed` | Actionable — install banner shown elsewhere. |
| Model too large | `unload` | `model exceeds memory` | OOM pre-check failed. |

The `status: "unload"` is the shared vocabulary (`use-system-health.ts`);
the `provider` string carries the specific reason. No schema change needed.

---

## Testing plan

| Test file | What it covers |
|---|---|
| `resource-planner.test.ts` | Memory formula: floor, param-count tiers (incl. unparseable-name fallback), q8_0 halving, dtype-before-context ordering (f16 fail → q8_0 fit → shrink → fail), ctx floor 2048, thread/batch clamping, idle formula. All pure functions — no mocks. |
| `runner.test.ts` | Mocked `child_process.spawn`: single-spawn under concurrency, idle timeout fires, crash-loop stops after 3, pidfile orphan adoption (alive+matching / stale / foreign-port reassign), SIGTERM on app exit, unknown-flag retry bounded to droppable set. |
| `detect.test.ts` | Mocked `fs`/`exec`: PATH scan, version parsing (`version: 7231 (…)`, `b7488`, garbage → null), minimum gate, directory scan of temp dirs, fit-first sorting. |
| `provider-factory.test.ts` (existing) | Extended: `gguf-model` kind → keyless OpenAI-compatible provider, `/v1` suffix appended. |
| `schema.test.ts` (existing) | Extended: `gguf-model` kind round-trips through `RegistryDocumentSchema`, `gguf` block validated, absent `idleMinutes` stays absent (no Zod default). |
| `provider-tab.test.tsx` (existing) | Extended: "Add GGUF Model" button renders, badge shows "GGUF". |
| `settings-api.test.ts` (existing) | Extended: `gguf` settings block persisted and read back. |
| `gguf-server.integration.test.ts` (new, env-gated) | **Skipped unless `LLAMA_TEST_BINARY` is set.** Spawns a real `llama-server` with a tiny model (e.g. Qwen2.5-0.5B Q8_0, ~500 MB, path via `LLAMA_TEST_MODEL`), then asserts: planned flags accepted (exit 0 + `/health` ok within timeout), `/v1/models` lists the model, one `/v1/chat/completions` round-trip returns non-empty content. Validates the planner's flags, `/health` + `/props` contract, and OpenAI-compatible behavior end to end. |

---

## Out of scope (v1)

| Item | Rationale |
|---|---|
| GGUF file downloads from HuggingFace | Users download manually (same as ONNX embedding workflow). |
| GGUF header parsing for exact KV math | Param-count tiers are sufficient; header parsing = future work. |
| GPU layer offload (`-ngl > 0`) auto-detection | Complex; manual override exposed instead. |
| Embedding via llama-server | Embeddings have their own provider pipeline. |
| Multi-slot / concurrent inference | Single-slot matches Yggdrasil's serial chat pattern. |
| Llama-server binary auto-download | User provides binary via platform installer. |
| Killing foreign port occupants | Never kill what we didn't spawn; reassign port instead. |

---

## Appendix: file layout (new files only)

```
src/lib/llama/
  detect.ts              — binary + model directory discovery
  runner.ts              — child-process lifecycle supervisor
  resource-planner.ts    — pure function: hardware → CLI flags
  types.ts               — shared types (LlamaResourceError, DeviceProfile, LlamaFlags)
  __tests__/
    detect.test.ts
    runner.test.ts
    resource-planner.test.ts
    gguf-server.integration.test.ts   — env-gated (LLAMA_TEST_BINARY + LLAMA_TEST_MODEL)
```

Modified files (summary):

- `src/lib/ai/provider-config/schema.ts` — add `gguf-model` to kind enum, add optional `gguf` block (no Zod defaults inside).
- `src/lib/ai/provider.ts` — branch `gguf-model` in `createProviderInstance` and `chatModelForEntry` (hook takes `entry, modelId`).
- `src/components/settings/tabs.tsx` — "Add GGUF Model" button and badge.
- `src/components/settings-view.tsx` — GGUF provider add flow, resource section.
- `src/hooks/use-system-health.ts` — (no change; `unload` reused with descriptive `provider` string).
- `src/lib/health/service-status.ts` — add `mapGgufHealth()` (mirrors `mapEmbeddingHealth` pattern).

---

## Appendix: memory budget worked examples (corrected)

**Example 1 — 16 GB machine, 5 GB free. Model: Qwen2.5-7B Q4_K_M (4.4 GB file).**

```
usable = 5 − max(1.5, 5 × 0.30) = 5 − 1.5 = 3.5 GB
overhead = 4.4 × 0.30 + 0.5 = 1.32 + 0.5 = 1.82 GB   ← within usable ✅
kvBudget = 3.5 − 1.82 = 1.68 GB = 1680 MB
params: "7B" → ≤9B tier → f16 0.30 MB/token, q8_0 0.15 MB/token
desired = 8192
  f16:  8192 × 0.30 = 2457 MB > 1680  → no
  q8_0: 8192 × 0.15 = 1229 MB ≤ 1680  → ✅
Result: ctx = 8192, kvDtype = q8_0 (full context preserved, near-lossless KV)
```

**Example 2 — 8 GB machine, 2.5 GB free. Same 4.4 GB model.**

```
usable = 2.5 − max(1.5, 0.75) = 2.5 − 1.5 = 1.0 GB
overhead = 1.82 GB > 1.0 GB  → FAIL FAST ✅
Error: "Model file (4.4 GB) exceeds estimated usable memory (1.0 GB). Try a smaller quantization."
```

**Example 3 — 8 GB machine, 4 GB free. Model: Phi-3-mini Q4 (2.3 GB file,
no param count in name).**

```
usable = 4 − max(1.5, 1.2) = 4 − 1.5 = 2.5 GB
overhead = 2.3 × 0.30 + 0.5 = 0.69 + 0.5 = 1.19 GB   ← within usable ✅
kvBudget = 2.5 − 1.19 = 1.31 GB = 1310 MB
params: unparseable → fallback tier → f16 0.60 MB/token, q8_0 0.30 MB/token
  (+ UI warning: "Could not determine parameter count for Phi-3-mini-…; using conservative estimate.")
desired = 8192
  f16:  8192 × 0.60 = 4915 MB > 1310  → no
  q8_0: 8192 × 0.30 = 2457 MB > 1310  → no
  shrink (q8_0): floor(1310 / 0.30) = 4366 ≥ 2048  → ✅
Result: ctx = 4366, kvDtype = q8_0 (context shrunk, reason surfaced in UI)
```
