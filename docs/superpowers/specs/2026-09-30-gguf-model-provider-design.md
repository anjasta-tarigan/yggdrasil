# GGUF Model Provider — Design Spec

**Date:** 2026-09-30
**Status:** Approved (awaiting implementation plan)
**Author:** Claude (brainstorming session with Anjasta)

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
    baseUrl: "http://127.0.0.1:<port>",
    models: [{ modelId: "Qwen2.5-7B-Instruct-Q4_K_M.gguf" }] }

Chat request targeting GGUF provider
   ▼
ensureGgufServerRunning(entry)          ← new hook, called before generation
   ▼
LlamaRunner (src/lib/llama/runner.ts)
   ├─ ensureRunning(): server up? → spawn llama-server (planned flags) → poll /health
   ├─ touch(): reset idle timer on each request
   └─ idle timeout → SIGTERM → standby
   ▼
createOpenAICompatible({ baseURL, dummy key })   ← existing provider.ts path
```

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

`cpuCores`, `totalMemBytes`, `freeMemBytes`, `modelSizeBytes`, GGUF metadata
(`contextWindow` from model — default 8192 when unknown), settings overrides.

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

// Resident estimate: with mmap on (default), weights page in lazily.
// Charge 40% of model size as resident (init touch + compute buffers).
// Full model size charge is a warning, not a rejection, when mmap is on.
const residentEstimate = modelSizeBytes * 0.40

if (residentEstimate > usable) {
  throw new LlamaResourceError(
    `Model file (${formatBytes(modelSizeBytes)}) exceeds estimated usable memory ` +
    `(${formatBytes(usable)}). Try a smaller quantization.`
  )
}
```

### Tiered KV-cache estimate (no GGUF header parsing needed)

Proxies `modelSizeBytes` (Q4-class files) to an upper-bound per-token KV cost:

| Model size (Q4) | Approx. params | est KV/token (f16) |
|---|---|---|
| < 1 GB | ~1.5B | 0.05 MB |
| 1 – 3 GB | ~3–8B | 0.15 MB |
| 3 – 8 GB | ~14–32B | 0.40 MB |
| > 8 GB | ~70B+ | 1.00 MB |

For `q8_0` KV cache, halve these values (q8_0 is near-lossless for KV).

```ts
function estKVPerToken(modelSizeBytes: number, kvDtype: "f16" | "q8_0"): number {
  const base =
    modelSizeBytes < GB(1)  ? 0.05 :
    modelSizeBytes < GB(3)  ? 0.15 :
    modelSizeBytes < GB(8)  ? 0.40 :
    /* >= 8 GB */              1.00

  return kvDtype === "q8_0" ? base / 2 : base
}
```

### Context derivation

```ts
const kvBudget = usable - residentEstimate
const perToken = estKVPerToken(modelSizeBytes, chosenKVDtype)
const maxCtxByMem = Math.floor(kvBudget / perToken)
const ctx = Math.min(contextWindowFromModel, maxCtxByMem)

if (ctx < 2048) {
  throw new LlamaResourceError(
    `Context too small (${ctx} tokens). Minimum 2048. Pick a smaller model.`
  )
}
```

### CLI flag derivation

| Flag | Value | Rationale |
|---|---|---|
| `-t` | `clamp(cores - 1, 2, 8)` | Leaves one core for the app; llama.cpp gains little past ~8 threads. |
| `-tb` | Same as `-t` | Prompt processing dominates; same budget. |
| `-np 1` | Fixed | Single chat slot; Yggdrasil serializes through one model. Unified KV. |
| `-c` | Derived above | Budget-constrained, never exceeds model's n_ctx_train. |
| `-ngl 0` | Default | CPU-only v1. Advanced override available (see §Advanced overrides). |
| `-b` | `clamp(ctx / 8, 256, 1024)` | Scales with context; avoids oversized batches on small ctx. |
| `-ub` | `clamp(ctx / 16, 128, 512)` | Physical batch = logical / 2. |
| `-ctk` / `-ctv` | f16 or q8_0 | See three-tier KV selection below. |
| `--cache-reuse 256` | On | KV-shifting prompt reuse — big win for agentic loops that resend the system prompt. |
| `--jinja` | On | Proper chat templates; required for tool calling on modern models. |
| `-fa on` | On (when supported) | Flash attention cuts KV memory; runner strips if unsupported (see §Fallback). |
| `--host 127.0.0.1` | Fixed | Never expose beyond localhost. |
| `--port <auto>` | Selected free port | Avoids collisions; port recorded in registry entry. |

### KV-cache dtype — three-tier selection

```ts
const headroomRatio = (usable - residentEstimate) / usable

if (headroomRatio >= 0.40) {
  kvDtype = "f16"         // ample headroom — use best quality
} else if (headroomRatio >= 0.15) {
  kvDtype = "q8_0"        // moderate pressure — near-lossless quant
} else {
  // Below 15% headroom: even q8_0 may cause OOM with full context.
  // Shrink context (handled by ctx derivation above); if still < 2048, fail fast.
  kvDtype = "q8_0"
}
```

**Explicit policy:** `q4_*` KV types are **not used by default** — they cause
subtle quality degradation on long-context reasoning, and the user specifically
flagged side-effect concerns. `q4_0`/`q4_1` are available only via an advanced
override with an on-screen warning.

### Idle timeout — dynamic default

```ts
const modelSizeGB = modelSizeBytes / (1024 ** 3)
const defaultIdleMinutes = Math.min(15, Math.max(3, Math.round(modelSizeGB)))
```

Small models (≤3 GB) unload after 3 min; large models (≥15 GB) stay 15 min.
Configurable per provider via settings.

---

## Runner — lifecycle supervisor

### Spawning

1. Plan flags via `resource-planner`.
2. Spawn `llama-server` as a child process (Node `child_process.spawn`, stdio
   piped to syslog and a tail buffer for UI error display).
3. Poll `GET http://127.0.0.1:<port>/health` every 500 ms (timeout 60 s for
   large-model first load).
4. On `{"status":"ok"}` → ready. Emit to health status.

### Idle shutdown

- Every request calls `runner.touch()` which resets the idle timer.
- On expiry: SIGTERM → wait 10 s → SIGKILL.
- Status transitions: `running → standby`.
- On next request: `standby → running` (re-spawn, same flags).

### Crash-loop guard

- If llama-server exits **non-zero within 10 s of spawn**, surface the last
  20 lines of stderr in the UI and stop retrying (no infinite restart loop).
- Max 3 restarts within a 5-minute window. After that, status → `unload` with
  an actionable error message.

### Orphan takeover

On process start (or provider first use), check port 2301 (or the configured
port): if something is already listening, hit `/health`. If healthy, adopt it
(younger PID wins). If not, kill it and take the port. This handles stale
processes from a crashed previous run.

### Unknown-flag fallback

If `llama-server` fails to start with "unrecognized argument" in stderr:

1. Strip the least-essential flags (`--cache-reuse`, `-fa`, `-ctk`, `-ctv`) one
   at a time and retry **once**.
2. If still failing, surface the full stderr in the UI. Do not retry further
   (preserves crash-loop guard).

---

## Detection — binary and model directory

### Binary discovery

```ts
function findLlamaServer(configuredPath?: string): { path: string; version: string } | null
```

1. If `configuredPath` is set and the file exists → use it.
2. Otherwise, scan `PATH` for `llama-server`.
3. If found, run `llama-server --version` (timeout 3 s). Parse version string
   (llama.cpp uses date-based versions like `b7488` or bare integers like
   `1830`; both are accepted). Store version.
4. If version < minimum (constant in code, updated per release), surface an
   actionable UI error: *"llama-server v1600 found, but v1800+ required for
   `--jinja` support. Update with `curl -LsSf https://llama.app/install.sh | sh`."*
5. If not found at all → `null`. UI shows the install banner.

### Model directory scan

```ts
function scanGgufModels(): Array<{ filename: string; path: string; sizeBytes: number }>
```

- Scan `data/models/GGUF-chatModel/` (relative to project root).
- Return all `*.gguf` files, sorted by size descending (largest quant first is
  a reasonable UX default — users typically download one model).
- If directory doesn't exist → return `[]` with a UI hint: *"Create the
  directory and place .gguf files there: `mkdir -p data/models/GGUF-chatModel`"*.

---

## Registry and schema changes

### Schema (`provider-config/schema.ts`)

```ts
// ProviderEntrySchema.kind — add to enum:
kind: z.enum(["openai-compatible", "ollama", "gguf-model", "web-session"])

// ProviderEntrySchema — optional gguf settings:
gguf: z.object({
  idleMinutes: z.number().min(1).max(60).default(5),
  contextWindow: z.number().int().min(2048).max(131072).optional(),
  ngl: z.number().int().min(0).max(100).default(0),
  kvDtype: z.enum(["auto", "f16", "q8_0"]).default("auto"),
  extraFlags: z.array(z.string().max(100)).max(10).optional(),
  serverPath: z.string().max(2048).optional(),
}).optional()
```

`gguf` block is optional on all providers; only meaningful when `kind === "gguf-model"`.

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

// chatModelForEntry — add pre-generation hook:
if (entry.kind === "gguf-model") {
  await ensureGgufServerRunning(entry)   // starts server if needed
  // ... proceed to create provider + wrap model
}
```

### Model entries under a gguf provider

Each `modelId` = the `.gguf` filename (e.g. `Qwen2.5-7B-Instruct-Q4_K_M.gguf`).
`displayName` = filename stem (no `.gguf` extension).
`capabilities.contextWindow` = default 8192; updated after model selection if
metadata is available. `isDefault` = true only if user explicitly sets it.

---

## UI changes

### Settings → Providers — "Add GGUF Model" button

New button alongside "Add Ollama" and "Add OpenAI-compatible endpoint":

1. **Binary status row:**
   - ✅ `llama-server v1830 found at /usr/local/bin/llama-server`
   - ❌ `llama-server not found — install with:` + copyable command:
     `curl -LsSf https://llama.app/install.sh | sh` + path picker for
     non-PATH installs.

2. **Model directory scan:**
   - List of `.gguf` files in `data/models/GGUF-chatModel/` with file size.
   - "No .gguf files found" + instructions to download from HuggingFace
     and place them in the directory.

3. User selects a model → creates provider entry + model entry.

### Provider card badge

`GGUF` badge (alongside existing `Ollama` / `OpenAI-compatible` badges) in the
providers list. Color: use the existing `Badge variant="outline"` pattern.

### Resource section (per-provider, advanced)

Shown when the provider is expanded:
- Computed flags (read-only display of what the planner chose).
- Editable overrides: context cap, KV dtype, ngl, idle timeout, extra flags.
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
| `resource-planner.test.ts` | Memory formula: floor, tiered estKV, q8_0 halving, ctx shrink, fail-fast. Thread/batch clamping. Idle timeout formula. All pure functions — no mocks. |
| `runner.test.ts` | Mocked `child_process.spawn`: single-spawn under concurrency, idle timeout fires, crash-loop stops after 3, orphan port takeover, SIGTERM on app exit. |
| `detect.test.ts` | Mocked `fs`/`exec`: PATH scan, version parsing (b7488, 1830), minimum gate, directory scan of temp dirs. |
| `provider-factory.test.ts` (existing) | Extended: `gguf-model` kind → keyless OpenAI-compatible provider, `/v1` suffix appended. |
| `schema.test.ts` (existing) | Extended: `gguf-model` kind round-trips through `RegistryDocumentSchema`, `gguf` block validated. |
| `provider-tab.test.tsx` (existing) | Extended: "Add GGUF Model" button renders, badge shows "GGUF". |
| `settings-api.test.ts` (existing) | Extended: `gguf` settings block persisted and read back. |

---

## Out of scope (v1)

| Item | Rationale |
|---|---|
| GGUF file downloads from HuggingFace | Users download manually (same as ONNX embedding workflow). |
| GGUF header parsing for exact KV math | Tiered estimate by model file size is sufficient; header parsing = future work. |
| GPU layer offload (`-ngl > 0`) auto-detection | Complex; advanced override exposed for manual use. |
| Embedding via llama-server | Embeddings have their own provider pipeline. |
| Multi-slot / concurrent inference | Single-slot matches Yggdrasil's serial chat pattern. |
| Llama-server binary auto-download | User provides binary via platform installer. |

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
```

Modified files (summary):

- `src/lib/ai/provider-config/schema.ts` — add `gguf-model` to kind enum, add optional `gguf` block.
- `src/lib/ai/provider.ts` — branch `gguf-model` in `createProviderInstance` and `chatModelForEntry`.
- `src/components/settings/tabs.tsx` — "Add GGUF Model" button and badge.
- `src/components/settings-view.tsx` — GGUF provider add flow, resource section.
- `src/hooks/use-system-health.ts` — (no change; `unload` reused with descriptive `provider` string).
- `src/lib/health/service-status.ts` — add `mapGgufHealth()` (mirrors `mapEmbeddingHealth` pattern).

---

## Appendix: memory budget worked example

**Machine:** 16 GB RAM, Next.js app using 6 GB, 5 GB free.
**Model:** Qwen2.5-7B Q4_K_M (~4.4 GB file).

```
usable = 5 GB − max(1.5 GB, 5 × 0.30) = 5 − 1.5 = 3.5 GB
residentEstimate = 4.4 GB × 0.40 = 1.76 GB    ← within usable ✅
kvBudget = 3.5 − 1.76 = 1.74 GB
perToken (7B Q4 → 1–3 GB bucket, f16) = 0.15 MB/token
maxCtx = 1740 / 0.15 = 11,600 tokens
ctx = min(model_n_ctx_train, 11600)            ← e.g. 8192 or 11600
```

**Machine:** 8 GB RAM, app using 4 GB, 2.5 GB free.
**Model:** Same 4.4 GB file.

```
usable = 2.5 − max(1.5, 0.75) = 2.5 − 1.5 = 1.0 GB
residentEstimate = 4.4 × 0.40 = 1.76 GB  > 1.0 GB  → FAIL FAST ✅
Error: "Model file (4.4 GB) exceeds estimated usable memory (1.0 GB). Try a smaller quantization."
```

**Machine:** 8 GB RAM, app using 3 GB, 4 GB free.
**Model:** Phi-3-mini Q4 (~2.3 GB file).

```
usable = 4 − max(1.5, 1.2) = 4 − 1.5 = 2.5 GB
residentEstimate = 2.3 × 0.40 = 0.92 GB    ← within usable ✅
kvBudget = 2.5 − 0.92 = 1.58 GB
perToken (3–8B bucket, f16) = 0.15 MB/token
maxCtx = 1580 / 0.15 = 10,533
headroomRatio = 1.58 / 2.5 = 0.63  ≥ 0.40  → f16 KV
ctx = min(model_n_ctx_train, 10533)
```
