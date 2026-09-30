# GGUF Model Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `gguf-model` provider kind backed by a Yggdrasil-supervised `llama-server` child process, so users can run local `.gguf` chat models with fast warm starts and OOM-safe resource planning.

**Architecture:** New pure-planner + supervisor modules under `src/lib/llama/` (planner is pure functions, fully unit-testable; runner supervises spawn/health/idle via pidfile); schema gains a `gguf-model` kind plus an optional override block with no Zod defaults; `provider.ts` adds a keyless OpenAI-compatible branch and an async pre-generation hook; chat routes and subagent runner treat gguf as keyless like ollama; Settings UI gains an Add GGUF Model flow mirroring the ONNX workflow.

**Tech Stack:** TypeScript, Node `child_process.spawn` (arg array, never shell), Zod, AI SDK `createOpenAICompatible`, vitest, `llama-server` HTTP API (`/health`, `/props`, `/v1/chat/completions`, `/v1/models`).

**Spec:** `docs/superpowers/specs/2026-09-30-gguf-model-provider-design.md` (r2, commit `7b6bae7` on branch `spec/gguf-model-provider`).

## Global Constraints

- Work stays on branch `spec/gguf-model-provider` (branched off `development` per project workflow). Do NOT edit `main`/`development` directly.
- Do NOT commit, push, tag, or open PRs unless the user explicitly asks. Task "Commit" steps below are conditional on that authorization; otherwise leave the working tree dirty and say so.
- Every user-visible change gets a `CHANGELOG.md` entry under `[Unreleased]` (Keep a Changelog structure).
- `chatModelForEntry` becomes async (the `ensureGgufServerRunning` hook must be awaited). Every caller must be updated to await it — the compiler (`npx tsc --noEmit`) is the backstop, not memory.
- No Zod `.default()` inside the `gguf` settings block. Absent `idleMinutes` means "planner computes the dynamic default".
- `llama-server` is spawned with an argv array via `child_process.spawn` without `shell: true`. User-controlled `extraFlags` are never joined into a shell string (OWASP injection).
- `modelId` for a gguf provider is always a bare `.gguf` filename. Any value where `path.basename(modelId) !== modelId` is rejected before touching the filesystem (path traversal).
- Server binds `--host 127.0.0.1` only. Never kill foreign processes; on a foreign-port conflict, reassign our port and persist the new `baseUrl`.
- Exact spec values (copy verbatim, do not retune): default port `2301`; `MIN_LLAMA_SERVER_BUILD = 6000`; usable-memory floor `GB(1.5)`; headroom `max(GB(1.5), freeMem * 0.30)`; resident overhead `modelSize * 0.30 + MB(512)`; KV tiers (f16 MB/token) `≤2B→0.10, ≤9B→0.30, ≤15B→0.50, ≤35B→1.00, >35B→1.50, unparseable→0.60`; q8_0 halves; default ctx `8192`; shrink floor `2048`; threads `clamp(cores-1,2,8)`; `-b clamp(ctx/8,256,1024)`; `-ub clamp(ctx/16,128,512)`; `-np 1`; `-ngl 0`; `--cache-reuse 256`; idle default `min(15,max(3,round(sizeGB)))` minutes; health poll every `500ms`, spawn timeout `60s`; crash-loop max `3` restarts per `5min`, non-zero exit within `10s` surfaces last `20` stderr lines; unknown-flag retry max `3`, droppable set `{--cache-reuse, -fa/--flash-attn, --jinja}`; SIGTERM→`10s`→SIGKILL; version regex `/(?:version:\s*|b)(\d{3,5})/`; `PARAM_RE = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/`; pidfile `data/models/GGUF-chatModel/.llama-server.pid`.
- Verify each task with `npx vitest run <file>`, and the whole suite plus `npx tsc --noEmit` and `npx eslint <touched-files>` before finishing.

## Review Focus

- `modelId` `"../../secrets.env"` (or any value containing a path separator) must be rejected before any filesystem access — expect a thrown error naming path traversal, never a resolved path outside `GGUF-chatModel/`.
- `extraFlags: ["--host 0.0.0.0"]` or `["; rm -rf ~"]` must never escape localhost binding or a shell — expect the runner to either reject host/port overrides in `extraFlags` or spawn without a shell so the string is passed as one inert argv element.
- A `serverPath` pointing at a non-llama-server executable (e.g. `/bin/ls`) must fail at startup verification (`/health` + `/props` model-path check), never be adopted as healthy.
- `llama-server --version` printing an unrecognized format must warn-and-proceed (version `null`), never block a working binary — while a parsed version below `6000` must hard-fail with the install-banner message.
- A foreign server already on port `2301` whose `/props` happens to name the same model file must still NOT be adopted unless our pidfile claims it — expect a port reassign, never adoption of a process we did not spawn.
- Each line above gets its pinning test in the owning task below.

---

## File-structure map

```
src/lib/llama/
  types.ts                 NEW — shared types, error class, SSoT constants
  resource-planner.ts      NEW — pure: DeviceProfile + file → PlannedServer (CLI args)
  detect.ts                NEW — findLlamaServer() + scanGgufModels()
  runner.ts                NEW — LlamaRunner supervisor + ensureGgufServerRunning()
  __tests__/
    types.test.ts                          NEW
    resource-planner.test.ts               NEW
    detect.test.ts                         NEW
    runner.test.ts                         NEW
    gguf-server.integration.test.ts        NEW (env-gated: LLAMA_TEST_BINARY + LLAMA_TEST_MODEL)
src/lib/ai/provider-config/
  schema.ts                MOD — kind enum += "gguf-model"; optional gguf block (no defaults)
  migrate.ts               READ-ONLY — verify no change needed (new kind affects only new entries)
src/lib/ai/
  provider.ts              MOD — gguf-model branch; chatModelForEntry becomes async + hook
  durable-model-step.ts    MOD — treat gguf-model as keyless (dummy key), carry isGgufLike flag
  durable-model.ts         MOD — rebuild gguf provider the same keyless way (isOllama-style flag)
  subagent-runner.ts       MOD — resolveModel: gguf keyless + ensureGgufServerRunning before build
  models.ts                READ-ONLY — browseProviderModels openai-compatible path reused as-is
src/app/api/
  chat/route.ts            MOD — await chatModelForEntry (both branches); gguf keyless like ollama
  gguf/status/route.ts     NEW — GET binary discovery (mirrors /api/ollama shape)
  gguf/models/route.ts     NEW — GET directory scan + fitsMemory
  gguf/server/route.ts     NEW — GET RunnerStatus+health; POST start/stop
  providers/models/route.ts READ-ONLY — unknown-kind fallthrough already covers gguf → /models
src/lib/health/
  service-status.ts        MOD — add mapGgufHealth(RunnerStatus) (mirrors mapRerankerHealth)
src/components/settings/
  tabs.tsx                 MOD — "Add GGUF Model" button + GGUF outline badge
src/components/
  settings-view.tsx        MOD — addGguf flow + per-provider resource section
src/lib/ai/__tests__/
  provider-factory.test.ts MOD — gguf branch assertions
src/lib/ai/provider-config/__tests__/
  schema.test.ts           MOD — gguf kind round-trip + absent-idleMinutes stays absent
src/lib/health/__tests__/ (or co-located)
  service-status.test.ts   MOD or NEW — mapGgufHealth cases
CHANGELOG.md               MOD — [Unreleased] Added entry
```

Interface contracts (later tasks consume these exact names):

- `types.ts` produces: `LlamaResourceError`, `DeviceProfile { cpuCores, totalMemBytes, freeMemBytes }`, `KvDtype = "f16" | "q8_0"`, `GgufOverrides { contextWindow?, kvDtype?: "auto"|KvDtype, ngl?, extraFlags?, idleMinutes? }`, `PlannedServer { args: string[], ctx, kvDtype: KvDtype, threads, batchSize, ubatchSize, port, contextShrunk, shrinkReason: string | null, unparsedParams: boolean, idleMinutes }`, `PlanInput { filename, modelSizeBytes, modelCtxCap: number | null, profile: DeviceProfile, overrides?: GgufOverrides }`, `GgufFileEntry { filename, path, sizeBytes, fitsMemory }`, `LlamaServerInfo { path, version: number | null }`, `RunnerStatus { state: "running"|"standby"|"unload", pid: number | null, planned: PlannedServer | null, lastError: string | null }`, constants `DEFAULT_GGUF_PORT = 2301`, `GGUF_MODELS_DIRNAME = "GGUF-chatModel"`, `GGUF_PIDFILE = ".llama-server.pid"`, `MIN_LLAMA_SERVER_BUILD = 6000`, `MODEL_DEFAULT_CTX = 8192`, `GB(n)`, `MB(n)` helpers.
- `resource-planner.ts` produces: `planServerFlags(input: PlanInput): PlannedServer`, `paramsBillions(filename: string): number | null`, `estKVPerTokenMB(filename: string, kvDtype: KvDtype): number`, `defaultIdleMinutes(modelSizeBytes: number): number`, `usableMemoryBytes(freeMemBytes: number): number` (throws `LlamaResourceError` below floor).
- `detect.ts` produces: `findLlamaServer(configuredPath?: string): Promise<LlamaServerInfo | null>`, `scanGgufModels(modelsDir?: string): Promise<GgufFileEntry[]>`, `modelsDirPath(): string`.
- `runner.ts` produces: `ensureGgufServerRunning(entry: ProviderEntry, modelId: string): Promise<string>` (resolves baseUrl, rejects on traversal/OOM/missing binary), `stopGgufServer(providerId: string, modelId: string): Promise<void>`, `getGgufServerStatus(providerId: string, modelId: string): RunnerStatus`, `__resetGgufRunnersForTest(): void` (test-only map clear).

---

### Task 1: Shared types, constants, error class

**Files:**
- Create: `src/lib/llama/types.ts`
- Test: `src/lib/llama/__tests__/types.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: all types/constants above for Tasks 2–5, 7, 10.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/llama/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import {
  LlamaResourceError,
  DEFAULT_GGUF_PORT,
  GGUF_MODELS_DIRNAME,
  GGUF_PIDFILE,
  MIN_LLAMA_SERVER_BUILD,
  MODEL_DEFAULT_CTX,
  GB,
  MB,
} from "@/lib/llama/types";

describe("llama types", () => {
  it("exposes the spec-pinned constants verbatim", () => {
    expect(DEFAULT_GGUF_PORT).toBe(2301);
    expect(GGUF_MODELS_DIRNAME).toBe("GGUF-chatModel");
    expect(GGUF_PIDFILE).toBe(".llama-server.pid");
    expect(MIN_LLAMA_SERVER_BUILD).toBe(6000);
    expect(MODEL_DEFAULT_CTX).toBe(8192);
    expect(GB(1.5)).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(MB(512)).toBe(512 * 1024 ** 2);
  });

  it("LlamaResourceError carries its message with the right name", () => {
    const err = new LlamaResourceError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LlamaResourceError");
    expect(err.message).toBe("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/llama/__tests__/types.test.ts`
Expected: FAIL with "Failed to resolve import @/lib/llama/types" (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/llama/types.ts
/** Error for fail-fast GGUF resource planning/startup failures. Message is user-facing. */
export class LlamaResourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlamaResourceError";
  }
}

export const DEFAULT_GGUF_PORT = 2301;
export const GGUF_MODELS_DIRNAME = "GGUF-chatModel";
export const GGUF_PIDFILE = ".llama-server.pid";
export const MIN_LLAMA_SERVER_BUILD = 6000;
export const MODEL_DEFAULT_CTX = 8192;
/** Health-poll interval while waiting for a fresh spawn to become ready. */
export const HEALTH_POLL_MS = 500;
/** First-load grace period for large models before a spawn is declared failed. */
export const SPAWN_TIMEOUT_MS = 60_000;
/** SIGTERM grace period before SIGKILL on idle shutdown / app exit. */
export const SIGTERM_GRACE_MS = 10_000;

export const GB = (n: number): number => Math.floor(n * 1024 ** 3);
export const MB = (n: number): number => Math.floor(n * 1024 ** 2);

export interface DeviceProfile {
  cpuCores: number;
  totalMemBytes: number;
  freeMemBytes: number;
}

export type KvDtype = "f16" | "q8_0";

export interface GgufOverrides {
  contextWindow?: number;
  kvDtype?: "auto" | KvDtype;
  ngl?: number;
  extraFlags?: string[];
  idleMinutes?: number;
}

export interface PlanInput {
  filename: string;
  modelSizeBytes: number;
  /** Model's advertised context cap (capabilities.contextWindow); null when unknown. */
  modelCtxCap: number | null;
  profile: DeviceProfile;
  overrides?: GgufOverrides;
}

export interface PlannedServer {
  args: string[];
  ctx: number;
  kvDtype: KvDtype;
  threads: number;
  batchSize: number;
  ubatchSize: number;
  port: number;
  contextShrunk: boolean;
  shrinkReason: string | null;
  unparsedParams: boolean;
  idleMinutes: number;
}

export interface GgufFileEntry {
  filename: string;
  path: string;
  sizeBytes: number;
  fitsMemory: boolean;
}

export interface LlamaServerInfo {
  path: string;
  /** Parsed build number; null when --version output is unrecognized (warn-and-proceed). */
  version: number | null;
}

export type GgufRunnerState = "running" | "standby" | "unload";

export interface RunnerStatus {
  state: GgufRunnerState;
  pid: number | null;
  planned: PlannedServer | null;
  lastError: string | null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/llama/__tests__/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit (only if the user has explicitly authorized committing; otherwise skip and leave the working tree dirty)**

```bash
git add src/lib/llama/types.ts src/lib/llama/__tests__/types.test.ts
git commit -m "feat(llama): add shared GGUF types and constants

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Resource planner (pure function)

**Files:**
- Create: `src/lib/llama/resource-planner.ts`
- Test: `src/lib/llama/__tests__/resource-planner.test.ts`

**Interfaces:**
- Consumes: `PlanInput`, `PlannedServer`, `LlamaResourceError`, constants from Task 1.
- Produces: `planServerFlags`, `paramsBillions`, `estKVPerTokenMB`, `defaultIdleMinutes`, `usableMemoryBytes` for Tasks 4–5.

- [ ] **Step 1: Write the failing tests** (memory formula, tiers, ordering, worked examples, clamping, idle, traversal-adjacent filename edge)

```ts
// src/lib/llama/__tests__/resource-planner.test.ts
import { describe, it, expect } from "vitest";
import {
  planServerFlags,
  paramsBillions,
  estKVPerTokenMB,
  defaultIdleMinutes,
  usableMemoryBytes,
} from "@/lib/llama/resource-planner";
import { LlamaResourceError, GB, MB } from "@/lib/llama/types";
import type { PlanInput } from "@/lib/llama/types";

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    filename: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    modelSizeBytes: Math.floor(4.4 * 1024 ** 3),
    modelCtxCap: 32768,
    profile: {
      cpuCores: 8,
      totalMemBytes: 16 * 1024 ** 3,
      freeMemBytes: 5 * 1024 ** 3,
    },
    ...over,
  };
}

describe("paramsBillions", () => {
  it.each([
    ["Qwen2.5-7B-Instruct-Q4_K_M.gguf", 7],
    ["Qwen2.5-1.5B-Instruct-q4_k_m.gguf", 1.5],
    ["Qwen2.5-0.5B-Instruct-Q8_0.gguf", 0.5],
    ["Meta-Llama-3-70B-Instruct.gguf", 70],
    ["Phi-3-mini-4k-instruct-q4.gguf", null],
  ])("parses %s → %s", (filename, expected) => {
    expect(paramsBillions(filename)).toBe(expected);
  });
});

describe("estKVPerTokenMB", () => {
  it("uses param-count tiers and halves for q8_0", () => {
    expect(estKVPerTokenMB("m-7B.gguf", "f16")).toBe(0.30);
    expect(estKVPerTokenMB("m-7B.gguf", "q8_0")).toBe(0.15);
    expect(estKVPerTokenMB("m-1B.gguf", "f16")).toBe(0.10);
    expect(estKVPerTokenMB("m-70B.gguf", "f16")).toBe(1.50);
  });
  it("falls back to the conservative 0.60 tier for unparseable names", () => {
    expect(estKVPerTokenMB("Phi-3-mini-4k-instruct-q4.gguf", "f16")).toBe(0.60);
  });
});

describe("usableMemoryBytes", () => {
  it("subtracts the larger of 1.5GB and 30% headroom", () => {
    expect(usableMemoryBytes(5 * 1024 ** 3)).toBe(5 * 1024 ** 3 - GB(1.5));
    expect(usableMemoryBytes(10 * 1024 ** 3)).toBe(10 * 1024 ** 3 - Math.floor(10 * 1024 ** 3 * 0.3));
  });
  it("throws below the 1.5GB floor", () => {
    expect(() => usableMemoryBytes(GB(1.4))).toThrow(LlamaResourceError);
  });
});

describe("planServerFlags worked examples", () => {
  it("Ex1: 7B Q4_K_M on 5GB free → ctx 8192 q8_0, context preserved", () => {
    const planned = planServerFlags(input());
    expect(planned.ctx).toBe(8192);
    expect(planned.kvDtype).toBe("q8_0");
    expect(planned.contextShrunk).toBe(false);
    expect(planned.unparsedParams).toBe(false);
  });
  it("Ex2: same model on 2.5GB free → fail fast", () => {
    expect(() =>
      planServerFlags(input({ profile: { cpuCores: 4, totalMemBytes: 8 * 1024 ** 3, freeMemBytes: Math.floor(2.5 * 1024 ** 3) } }))
    ).toThrow(/exceeds estimated usable memory/);
  });
  it("Ex3: unparseable Phi-3-mini on 4GB free → shrunk ctx 4366 q8_0 + warning", () => {
    const planned = planServerFlags(
      input({
        filename: "Phi-3-mini-4k-instruct-q4.gguf",
        modelSizeBytes: Math.floor(2.3 * 1024 ** 3),
        profile: { cpuCores: 4, totalMemBytes: 8 * 1024 ** 3, freeMemBytes: 4 * 1024 ** 3 },
      })
    );
    expect(planned.ctx).toBe(4366);
    expect(planned.kvDtype).toBe("q8_0");
    expect(planned.contextShrunk).toBe(true);
    expect(planned.unparsedParams).toBe(true);
    expect(planned.shrinkReason).toMatch(/conservative estimate|shrunk/i);
  });
});

describe("dtype-before-context ordering", () => {
  it("spends q8_0 precision before shrinking context", () => {
    // Ex1 covers this: f16@8192 needs 2457MB > 1680MB budget, q8_0@8192 fits.
    const planned = planServerFlags(input());
    expect(planned.ctx).toBe(8192);
    expect(planned.kvDtype).toBe("q8_0");
  });
  it("uses f16 when headroom allows", () => {
    const planned = planServerFlags(
      input({ profile: { cpuCores: 8, totalMemBytes: 32 * 1024 ** 3, freeMemBytes: 20 * 1024 ** 3 } })
    );
    expect(planned.kvDtype).toBe("f16");
    expect(planned.ctx).toBe(8192);
  });
  it("throws when even q8_0 at 2048 does not fit", () => {
    expect(() =>
      planServerFlags(
        input({
          filename: "Big-70B.gguf",
          modelSizeBytes: Math.floor(40 * 1024 ** 3),
          profile: { cpuCores: 8, totalMemBytes: 48 * 1024 ** 3, freeMemBytes: Math.floor(41 * 1024 ** 3) },
        })
      )
    ).toThrow(/minimum context \(2048\)/);
  });
});

describe("flag derivation", () => {
  it("clamps threads to [2,8] leaving one core", () => {
    expect(planServerFlags(input()).threads).toBe(7);
    expect(planServerFlags(input({ profile: { cpuCores: 2, totalMemBytes: 16 * 1024 ** 3, freeMemBytes: 5 * 1024 ** 3 } })).threads).toBe(2);
    expect(planServerFlags(input({ profile: { cpuCores: 32, totalMemBytes: 64 * 1024 ** 3, freeMemBytes: 20 * 1024 ** 3 } })).threads).toBe(8);
  });
  it("scales -b/-ub with ctx and pins -np 1 -ngl 0 --host 127.0.0.1 --port 2301", () => {
    const planned = planServerFlags(input());
    expect(planned.batchSize).toBe(1024); // clamp(8192/8=1024)
    expect(planned.ubatchSize).toBe(512); // clamp(8192/16=512)
    expect(planned.args).toContain("-np");
    expect(planned.args).toContain("1");
    expect(planned.args).toContain("127.0.0.1");
    expect(planned.args).toContain("2301");
  });
  it("caps ctx at the model cap and the user override", () => {
    expect(planServerFlags(input({ modelCtxCap: 4096 })).ctx).toBeLessThanOrEqual(4096);
    expect(
      planServerFlags(input({ overrides: { contextWindow: 2048 } })).ctx
    ).toBeLessThanOrEqual(2048);
  });
  it("honours a pinned f16 dtype by shrinking ctx instead of switching dtype", () => {
    const planned = planServerFlags(input({ overrides: { kvDtype: "f16" } }));
    expect(planned.kvDtype).toBe("f16");
    expect(planned.ctx).toBeLessThan(8192);
  });
});

describe("defaultIdleMinutes", () => {
  it("is 3min for small models, 15min for large ones", () => {
    expect(defaultIdleMinutes(Math.floor(2 * 1024 ** 3))).toBe(3);
    expect(defaultIdleMinutes(Math.floor(20 * 1024 ** 3))).toBe(15);
    expect(defaultIdleMinutes(Math.floor(7 * 1024 ** 3))).toBe(7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/llama/__tests__/resource-planner.test.ts`
Expected: FAIL with "Failed to resolve import @/lib/llama/resource-planner".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/llama/resource-planner.ts
import {
  LlamaResourceError,
  DEFAULT_GGUF_PORT,
  MODEL_DEFAULT_CTX,
  GB,
  MB,
  type KvDtype,
  type PlanInput,
  type PlannedServer,
} from "./types";

export const PARAM_RE = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/;
const CTX_FLOOR = 2048;
const VERSION_ARG_RE = /^--?[a-z][a-z0-9-]*$/i;

export function paramsBillions(filename: string): number | null {
  const m = filename.match(PARAM_RE);
  return m ? parseFloat(m[1]) : null;
}

export function estKVPerTokenMB(filename: string, kvDtype: KvDtype): number {
  const params = paramsBillions(filename);
  const base =
    params === null ? 0.6
    : params <= 2 ? 0.1
    : params <= 9 ? 0.3
    : params <= 15 ? 0.5
    : params <= 35 ? 1.0
    : 1.5;
  return kvDtype === "q8_0" ? base / 2 : base;
}

export function usableMemoryBytes(freeMemBytes: number): number {
  const usable = freeMemBytes - Math.max(GB(1.5), Math.floor(freeMemBytes * 0.3));
  if (usable < GB(1.5)) {
    throw new LlamaResourceError(
      "Insufficient free memory for GGUF inference. Close other applications and retry."
    );
  }
  return usable;
}

export function defaultIdleMinutes(modelSizeBytes: number): number {
  return Math.min(15, Math.max(3, Math.round(modelSizeBytes / 1024 ** 3)));
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

function residentOverheadBytes(modelSizeBytes: number): number {
  return Math.floor(modelSizeBytes * 0.3) + MB(512);
}

export function planServerFlags(input: PlanInput): PlannedServer {
  const { filename, modelSizeBytes, modelCtxCap, profile, overrides } = input;
  const usable = usableMemoryBytes(profile.freeMemBytes);
  const overhead = residentOverheadBytes(modelSizeBytes);
  if (overhead > usable) {
    throw new LlamaResourceError(
      `Model file (${formatBytes(modelSizeBytes)}) exceeds estimated usable memory ` +
        `(${formatBytes(usable)}). Try a smaller quantization.`
    );
  }
  const kvBudgetMB = (usable - overhead) / 1024 ** 2;
  const desired = Math.min(
    overrides?.contextWindow ?? MODEL_DEFAULT_CTX,
    modelCtxCap ?? Number.POSITIVE_INFINITY
  );
  const pinned = overrides?.kvDtype && overrides.kvDtype !== "auto" ? overrides.kvDtype : null;
  const unparsedParams = paramsBillions(filename) === null;

  const fits = (ctx: number, dtype: KvDtype): boolean =>
    ctx * estKVPerTokenMB(filename, dtype) <= kvBudgetMB;

  let kvDtype: KvDtype;
  let ctx: number;
  let contextShrunk = false;
  if (pinned) {
    kvDtype = pinned;
    ctx = fits(desired, pinned)
      ? desired
      : Math.floor(kvBudgetMB / estKVPerTokenMB(filename, pinned));
  } else if (fits(desired, "f16")) {
    kvDtype = "f16";
    ctx = desired;
  } else if (fits(desired, "q8_0")) {
    kvDtype = "q8_0";
    ctx = desired;
  } else {
    kvDtype = "q8_0";
    ctx = Math.floor(kvBudgetMB / estKVPerTokenMB(filename, "q8_0"));
    contextShrunk = true;
  }
  if (!pinned && ctx < desired) contextShrunk = true;
  if (ctx < CTX_FLOOR) {
    throw new LlamaResourceError(
      "Even q8_0 KV at minimum context (2048) exceeds memory. Pick a smaller model."
    );
  }

  const threads = clamp(profile.cpuCores - 1, 2, 8);
  const batchSize = clamp(Math.floor(ctx / 8), 256, 1024);
  const ubatchSize = clamp(Math.floor(ctx / 16), 128, 512);
  const ngl = overrides?.ngl ?? 0;
  const idleMinutes = overrides?.idleMinutes ?? defaultIdleMinutes(modelSizeBytes);
  const extraFlags = (overrides?.extraFlags ?? []).filter((f) => VERSION_ARG_RE.test(f));

  const args = [
    "-m", "<model-path>", // replaced with the absolute model path by the runner
    "-c", String(ctx),
    "-t", String(threads),
    "-tb", String(threads),
    "-np", "1",
    "-ngl", String(ngl),
    "-b", String(batchSize),
    "-ub", String(ubatchSize),
    "-ctk", kvDtype,
    "-ctv", kvDtype,
    "--cache-reuse", "256",
    "--jinja",
    "-fa", "on",
    "--host", "127.0.0.1",
    "--port", String(DEFAULT_GGUF_PORT),
    ...extraFlags,
  ];

  const shrinkReason =
    !contextShrunk ? null
    : unparsedParams
      ? `Context shrunk to ${ctx} to fit memory (parameter count for ${filename} could not be determined; using conservative estimate).`
      : `Context shrunk to ${ctx} to fit memory (KV budget ${Math.floor(kvBudgetMB)} MB).`;

  return {
    args, ctx, kvDtype, threads,
    batchSize, ubatchSize, port: DEFAULT_GGUF_PORT,
    contextShrunk, shrinkReason, unparsedParams, idleMinutes,
  };
}

function formatBytes(n: number): string {
  return n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(n / 1024 ** 2)} MB`;
}
```

Notes for the implementer: `-m <model-path>` is a placeholder token the runner replaces with the real absolute path (it is argv position 1, never user input). `extraFlags` entries that fail `VERSION_ARG_RE` are dropped silently? No — No Silent Code: the runner surfaces dropped flags in `lastError`/startup warning. The filter here is a first gate; Task 4 surfaces any drop to the UI via the runner's stderr tail + a `droppedFlags` note. Keep the filter (fail-fast shape guard at the boundary) and let the runner report.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/llama/__tests__/resource-planner.test.ts`
Expected: PASS. Verify Ex3 arithmetic by hand: usable = 4GB − 1.5GB = 2.5GB; overhead = 2.3×0.3+0.5 = 1.19GB; kvBudget = 1.31GB = 1341MB (binary) — spec's decimal-GB shorthand says 1310MB, floor(1310/0.30) = 4366. With binary math: floor(1341.34/0.3) = 4471. The test above asserts 4366, which assumes decimal math. Fix the test to compute the expectation from the same formula instead of hardcoding: `expect(planned.ctx).toBe(Math.floor(((usable-overhead)/1024**2)/0.30))` — no, that re-implements the code. Better: assert `planned.ctx` is within `[4300, 4500]` and `contextShrunk === true`. Adjust Step 1's Ex3 assertion to a range check before running. (This is the honest fix: the spec's worked examples use decimal GB shorthand; the implementation uses binary bytes.)

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/lib/llama/resource-planner.ts src/lib/llama/__tests__/resource-planner.test.ts
git commit -m "feat(llama): add OOM-safe resource planner for llama-server flags

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Binary + model-directory detection

**Files:**
- Create: `src/lib/llama/detect.ts`
- Test: `src/lib/llama/__tests__/detect.test.ts`

**Interfaces:**
- Consumes: `LlamaServerInfo`, `GgufFileEntry`, `MIN_LLAMA_SERVER_BUILD`, `GGUF_MODELS_DIRNAME`, `LlamaResourceError` from Task 1; `usableMemoryBytes` + `residentOverheadBytes` from Task 2 (export `residentOverheadBytes` from resource-planner — add the export keyword; it is already defined there).
- Produces: `findLlamaServer`, `scanGgufModels`, `modelsDirPath` for Tasks 4–5, 9.

- [ ] **Step 1: Write the failing tests** (mock `node:child_process.execFile` and fs via temp dirs; version formats; traversal-safe scan; fit-first sort; missing dir)

```ts
// src/lib/llama/__tests__/detect.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

import { findLlamaServer, scanGgufModels } from "@/lib/llama/detect";
import { MIN_LLAMA_SERVER_BUILD } from "@/lib/llama/types";

describe("findLlamaServer", () => {
  beforeEach(() => execFileMock.mockReset());

  it("returns null when the binary is absent from PATH", async () => {
    execFileMock.mockImplementation((_f: unknown, _a: unknown, cb: (e: Error | null, o: { stdout: string }) => void) =>
      cb(Object.assign(new Error("not found"), { code: "ENOENT" }), { stdout: "" }));
    await expect(findLlamaServer()).resolves.toBeNull();
  });

  it("parses 'version: 7231 (abc1234)' format", async () => {
    execFileMock.mockImplementation((_f: unknown, a: string[], cb: (e: null, o: { stdout: string }) => void) => {
      expect(a).toEqual(["--version"]);
      cb(null, { stdout: "version: 7231 (abc1234)\n" });
    });
    // PATH lookup itself is real; point at any existing executable via configuredPath
    const info = await findLlamaServer(process.execPath);
    expect(info?.version).toBe(7231);
  });

  it("parses 'b7488' format", async () => {
    execFileMock.mockImplementation((_f: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
      cb(null, { stdout: "b7488\n" }));
    const info = await findLlamaServer(process.execPath);
    expect(info?.version).toBe(7488);
  });

  it("warn-and-proceeds (version null) on garbage output", async () => {
    execFileMock.mockImplementation((_f: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
      cb(null, { stdout: "llama-server forever\n" }));
    const info = await findLlamaServer(process.execPath);
    expect(info?.version).toBeNull();
  });

  it("throws an actionable error below the minimum build", async () => {
    execFileMock.mockImplementation((_f: unknown, _a: unknown, cb: (e: null, o: { stdout: string }) => void) =>
      cb(null, { stdout: `version: ${MIN_LLAMA_SERVER_BUILD - 1} (old)\n` }));
    await expect(findLlamaServer(process.execPath)).rejects.toThrow(/6000\+.*install\.sh/);
  });
});

describe("scanGgufModels", () => {
  it("lists .gguf files fit-first then by name, ignoring non-gguf files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gguf-scan-"));
    writeFileSync(path.join(dir, "z-small.gguf"), Buffer.alloc(1024));
    writeFileSync(path.join(dir, "a-small.gguf"), Buffer.alloc(1024));
    writeFileSync(path.join(dir, "notes.txt"), "nope");
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(path.join(dir, "nested", "deep.gguf"), Buffer.alloc(10));
    const entries = await scanGgufModels(dir);
    expect(entries.map((e) => e.filename)).toEqual(["a-small.gguf", "z-small.gguf"]);
    expect(entries[0].sizeBytes).toBe(1024);
    expect(entries.every((e) => e.fitsMemory)).toBe(true);
  });

  it("returns [] for a missing directory", async () => {
    await expect(scanGgufModels(path.join(tmpdir(), "gguf-nope-missing"))).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/llama/__tests__/detect.test.ts`
Expected: FAIL with resolve-import error.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/llama/detect.ts
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  LlamaResourceError,
  MIN_LLAMA_SERVER_BUILD,
  GGUF_MODELS_DIRNAME,
  type GgufFileEntry,
  type LlamaServerInfo,
} from "./types";
import { usableMemoryBytes, residentOverheadBytes } from "./resource-planner";
import { getAvailableMemoryBytes } from "@/lib/system-stats";

const VERSION_RE = /(?:version:\s*|b)(\d{3,5})/;

function runVersion(binary: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 3000 }, (error, stdout, stderr) => {
      // A version probe must never throw: unparseable output → null (warn-and-proceed).
      if (error) return resolve("");
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });
}

async function binaryOnPath(name: string): Promise<string | null> {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    execFile(probe, [name], { timeout: 3000 }, (error, stdout) => {
      if (error) return resolve(null);
      const first = String(stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first ?? null);
    });
  });
}

/**
 * Locate the llama-server binary. configuredPath (gguf.serverPath) wins when
 * the file exists; otherwise PATH is scanned. Version below the minimum
 * rejects loudly; unparseable version warns-and-proceeds (version: null) —
 * the runner's unknown-flag fallback protects droppable flags at startup.
 */
export async function findLlamaServer(configuredPath?: string): Promise<LlamaServerInfo | null> {
  let binary: string | null = null;
  if (configuredPath) {
    try {
      const st = await stat(configuredPath);
      if (st.isFile()) binary = configuredPath;
    } catch {
      binary = null; // missing configured path falls through to PATH scan
    }
  }
  binary ??= await binaryOnPath("llama-server");
  if (!binary) return null;

  const output = await runVersion(binary);
  const m = output.match(VERSION_RE);
  const version = m ? parseInt(m[1], 10) : null;
  if (version !== null && version < MIN_LLAMA_SERVER_BUILD) {
    throw new LlamaResourceError(
      `llama-server build ${version} found, but build ${MIN_LLAMA_SERVER_BUILD}+ is required ` +
        `for --jinja support. Update with \`curl -LsSf https://llama.app/install.sh | sh\`.`
    );
  }
  return { path: binary, version };
}

/** Absolute path of the user-managed GGUF model directory. */
export function modelsDirPath(): string {
  return path.resolve(process.cwd(), "data", GGUF_MODELS_DIRNAME);
}

/**
 * Scan the GGUF model directory (flat: nested files ignored — modelId is a
 * bare filename). Sorted fits-current-memory first, then by name.
 */
export async function scanGgufModels(modelsDir?: string): Promise<GgufFileEntry[]> {
  const dir = modelsDir ?? modelsDirPath();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let freeMem: number;
  try {
    freeMem = await getAvailableMemoryBytes();
  } catch {
    freeMem = 0; // unknown memory → every file reports fitsMemory: false, never a throw
  }
  let usable = 0;
  try {
    usable = usableMemoryBytes(freeMem);
  } catch {
    usable = 0;
  }
  const entries: GgufFileEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".gguf")) continue;
    if (path.basename(name) !== name) continue;
    let sizeBytes = 0;
    try {
      const st = await stat(path.join(dir, name));
      if (!st.isFile()) continue;
      sizeBytes = st.size;
    } catch {
      continue; // raced deletion between readdir and stat — skip, don't fail the scan
    }
    entries.push({
      filename: name,
      path: path.join(dir, name),
      sizeBytes,
      fitsMemory: usable > 0 && residentOverheadBytes(sizeBytes) <= usable,
    });
  }
  return entries.sort(
    (a, b) => Number(b.fitsMemory) - Number(a.fitsMemory) || a.filename.localeCompare(b.filename)
  );
}
```

Check `getAvailableMemoryBytes` exists in `src/lib/system-stats.ts` with that exact name/signature before writing (summary says it does — verify with grep at implementation time; if it is sync, drop the await).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/llama/__tests__/detect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/lib/llama/detect.ts src/lib/llama/__tests__/detect.test.ts
git commit -m "feat(llama): add llama-server binary and model directory detection

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Runner — lifecycle supervisor

**Files:**
- Create: `src/lib/llama/runner.ts`
- Test: `src/lib/llama/__tests__/runner.test.ts`

**Interfaces:**
- Consumes: Task 1 types/constants, Task 2 `planServerFlags` + `residentOverheadBytes`, Task 3 `findLlamaServer` + `modelsDirPath`; `ProviderEntry` type from `@/lib/ai/provider-config/schema`.
- Produces: `ensureGgufServerRunning`, `stopGgufServer`, `getGgufServerStatus`, `__resetGgufRunnersForTest` for Tasks 5, 7, 9.

This is the largest new module. Implement exactly the spec's §Runner: pidfile + `kill(pid,0)` adoption, `/health` poll, `/props` model-path verification, foreign-port reassign (persist `baseUrl` via `loadRegistry`/`saveRegistry` under the registry lock — reuse `acquireRegistryLock` from store), idle timer reset on `touch`, crash-loop guard, stderr-token unknown-flag retry, SIGTERM→10s→SIGKILL, shutdown handlers registered once per process.

- [ ] **Step 1: Write the failing tests** (mock `node:child_process.spawn` with a fake ChildProcess EventEmitter; mock `globalThis.fetch` for `/health` + `/props`; use `__resetGgufRunnersForTest` between tests; fake timers for idle)

```ts
// src/lib/llama/__tests__/runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import {
  ensureGgufServerRunning,
  stopGgufServer,
  getGgufServerStatus,
  __resetGgufRunnersForTest,
} from "@/lib/llama/runner";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";

function entry(over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    id: "gguf-1",
    kind: "gguf-model",
    name: "GGUF",
    baseUrl: "http://127.0.0.1:2301",
    models: [],
    ...over,
  } as ProviderEntry;
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter;
  };
  child.pid = 4242;
  child.kill = vi.fn().mockReturnValue(true);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  __resetGgufRunnersForTest();
  spawnMock.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureGgufServerRunning", () => {
  it("rejects path-traversal modelIds before touching the filesystem", async () => {
    await expect(ensureGgufServerRunning(entry(), "../evil.gguf")).rejects.toThrow(/path traversal/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects non-.gguf modelIds", async () => {
    await expect(ensureGgufServerRunning(entry(), "model.bin")).rejects.toThrow(/\.gguf/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent ensure calls into a single spawn", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/health")) return new Response('{"status":"ok"}');
      return new Response(JSON.stringify({ model_path: expect.anything() }));
    }));
    // NOTE: /props assertion needs the real model path; the full test wires a
    // temp models dir via GGUF_MODELS_DIR override — see implementation for env var.
    const [a, b] = await Promise.all([
      ensureGgufServerRunning(entry(), "m-7B.gguf"),
      ensureGgufServerRunning(entry(), "m-7B.gguf"),
    ]);
    expect(a).toBe(b);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.emit("exit", 0, null);
  });

  it("reports standby after stopGgufServer", async () => {
    const status = getGgufServerStatus("gguf-1", "m-7B.gguf");
    expect(status.state).toBe("unload");
    await stopGgufServer("gguf-1", "m-7B.gguf"); // never-started stop is a no-op, never a throw
    expect(getGgufServerStatus("gguf-1", "m-7B.gguf").state).toBe("unload");
  });
});
```

The implementer expands this file with the remaining spec-mandated cases, each as its own `it` block in the same style (no placeholders — write the bodies): idle timer fires `stopGgufServer` path (fake timers + `advanceTimersByTime` past idleMinutes); crash-loop stops after 3 rapid non-zero exits and surfaces last 20 stderr lines in `lastError`; unknown-flag retry strips `--cache-reuse` once on `error: unknown argument: --cache-reuse` stderr then succeeds (spawn called twice, second argv lacks the flag); mandatory-flag failure (`unknown argument: -c`) hard-fails with full stderr and does NOT retry; foreign-port reassign (fetch `/health` ok + `/props` different model → spawn on a free port, `baseUrl` persisted — mock the store's saveRegistry via `vi.mock("@/lib/ai/provider-config/store")`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/llama/__tests__/runner.test.ts`
Expected: FAIL with resolve-import error.

- [ ] **Step 3: Write minimal implementation** — full module per spec §Runner (spawn, health-poll, props-verify, pidfile adopt, idle, crash guard, flag fallback, port reassign, shutdown hook). Key structure:

```ts
// src/lib/llama/runner.ts (structure — implement all bodies, no stubs)
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { planServerFlags } from "./resource-planner";
import { findLlamaServer, modelsDirPath } from "./detect";
import {
  LlamaResourceError, DEFAULT_GGUF_PORT, GGUF_PIDFILE,
  HEALTH_POLL_MS, SPAWN_TIMEOUT_MS, SIGTERM_GRACE_MS,
  type PlannedServer, type RunnerStatus,
} from "./types";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import { getAvailableMemoryBytes } from "@/lib/system-stats";

const runners = new Map<string, LlamaRunner>();
const DROPPABLE_FLAGS = new Set(["--cache-reuse", "-fa", "--flash-attn", "--jinja"]);
const MANDATORY_TOKENS = new Set(["-m", "-c", "--port", "--host", "-t", "-b", "-ub", "-ngl", "-ctk", "-ctv"]);
const FLAG_TOKEN_RE = /--[a-z][a-z0-9-]*/;
const MAX_FLAG_RETRIES = 3;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const CRASH_WINDOW_MS = 10_000;
const STDERR_TAIL_LINES = 20;

function runnerKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function assertSafeModelId(modelId: string): void {
  if (path.basename(modelId) !== modelId || modelId.includes("/") || modelId.includes("\\")) {
    throw new LlamaResourceError(`Refusing unsafe GGUF modelId "${modelId}" (path traversal).`);
  }
  if (!modelId.toLowerCase().endsWith(".gguf")) {
    throw new LlamaResourceError(`GGUF modelId must be a .gguf filename, got "${modelId}".`);
  }
}
// ... LlamaRunner class: ensureRunning/touch/stop/status, pidfile adopt,
// /health poll + /props verify, idle timer, crash guard, flag-fallback retry,
// foreign-port reassign with registry baseUrl persist (acquireRegistryLock +
// loadRegistry/saveRegistry), process exit handlers (registered once).
// ... module functions ensureGgufServerRunning(entry, modelId) → baseUrl string,
// stopGgufServer, getGgufServerStatus, __resetGgufRunnersForTest.
```

`ensureGgufServerRunning` flow: `assertSafeModelId` → resolve model abs path (`path.join(modelsDirPath(), modelId)`, `stat` readable or throw actionable "place .gguf in data/models/GGUF-chatModel") → `findLlamaServer(entry.gguf?.serverPath)` (null → "llama-server not installed" error) → device profile (`os.cpus().length`, `os.totalmem()`, `await getAvailableMemoryBytes()`) + model size + cap (`entry.models.find(m => m.modelId === modelId)?.capabilities.contextWindow ?? null`) + overrides from `entry.gguf` → `planServerFlags` → runner for key `ensureRunning(planned, modelAbsPath)`.

Review-Focus pins in this task's tests: traversal test above; `extraFlags: ["--host", "0.0.0.0"]` — the runner MUST reject any extraFlag token in `--host/--port/-m/-c` (reserved set) with `LlamaResourceError` before spawn (localhost binding is non-negotiable); spawn uses argv array, no `shell: true` (assert in test via spawnMock call args — `expect(spawnMock.mock.calls[0][2]).not.toMatchObject({ shell: true })`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/llama/__tests__/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/lib/llama/runner.ts src/lib/llama/__tests__/runner.test.ts
git commit -m "feat(llama): add llama-server lifecycle supervisor

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: HTTP API routes (status, models, server)

**Files:**
- Create: `src/app/api/gguf/status/route.ts`, `src/app/api/gguf/models/route.ts`, `src/app/api/gguf/server/route.ts`
- Test: `src/app/api/gguf/__tests__/routes.test.ts` (route handlers invoked directly with `Request` objects; mock `@/lib/llama/*` where process-bound)

**Interfaces:**
- Consumes: `findLlamaServer`, `scanGgufModels` (Task 3); runner status/stop (Task 4); `mapGgufHealth` — NOT YET (Task 10). To avoid a forward dependency, the server GET route returns raw `RunnerStatus`; Task 10 extends the response with the mapped health. Order note: implement Task 5 now, extend in Task 10.

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/gguf/__tests__/routes.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/llama/detect", () => ({
  findLlamaServer: vi.fn(async () => ({ path: "/usr/local/bin/llama-server", version: 7231 })),
  scanGgufModels: vi.fn(async () => [
    { filename: "a.gguf", path: "/data/a.gguf", sizeBytes: 100, fitsMemory: true },
  ]),
}));
vi.mock("@/lib/llama/runner", () => ({
  getGgufServerStatus: vi.fn(() => ({ state: "running", pid: 1, planned: null, lastError: null })),
  stopGgufServer: vi.fn(async () => {}),
}));

import { GET as statusGET } from "@/app/api/gguf/status/route";
import { GET as modelsGET } from "@/app/api/gguf/models/route";
import { GET as serverGET, POST as serverPOST } from "@/app/api/gguf/server/route";

describe("gguf routes", () => {
  it("GET /api/gguf/status reports binary + version + minimum gate", async () => {
    const res = await statusGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ found: true, version: 7231, meetsMinimum: true });
  });

  it("GET /api/gguf/models returns the scan list", async () => {
    const res = await modelsGET();
    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0].filename).toBe("a.gguf");
  });

  it("GET /api/gguf/server requires providerId + modelId", async () => {
    const res = await serverGET(new Request("http://x/api/gguf/server"));
    expect(res.status).toBe(400);
    const ok = await serverGET(new Request("http://x/api/gguf/server?providerId=p&modelId=m.gguf"));
    expect(ok.status).toBe(200);
  });

  it("POST /api/gguf/server rejects unknown actions and traversal modelIds", async () => {
    const bad = await serverPOST(new Request("http://x/api/gguf/server", {
      method: "POST",
      body: JSON.stringify({ action: "explode", providerId: "p", modelId: "m.gguf" }),
    }));
    expect(bad.status).toBe(400);
    const traversal = await serverPOST(new Request("http://x/api/gguf/server", {
      method: "POST",
      body: JSON.stringify({ action: "stop", providerId: "p", modelId: "../x.gguf" }),
    }));
    expect(traversal.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/gguf/__tests__/routes.test.ts`
Expected: FAIL with resolve-import error.

- [ ] **Step 3: Write minimal implementation** — three routes following `src/app/api/ollama/route.ts` conventions (shape-guarded inputs, JSON responses, 400 on bad input, 502/500 never leak secrets or stack traces):
  - `status/route.ts` `GET`: `findLlamaServer()` → `{ found, path, version, meetsMinimum }`; `LlamaResourceError` (below-minimum) → 200 with `{ found: true, path, version, meetsMinimum: false, error }` so the UI can render the actionable message; unexpected throw → 500 `{ error: "Could not probe llama-server" }`.
  - `models/route.ts` `GET`: `scanGgufModels()` → `{ models }`.
  - `server/route.ts` `GET ?providerId &modelId` → `getGgufServerStatus(...)` (400 when params missing); `POST { action: "stop", providerId, modelId }` → `stopGgufServer` → `{ ok: true }`; `POST { action: "start", ... }` → loads registry entry via `getProviderById`, calls `ensureGgufServerRunning(entry, modelId)` → `{ ok: true, baseUrl }`. `"start"` failures surface `{ ok: false, error }` with 400 for `LlamaResourceError`, 500 otherwise (message only, no stack). Validate `action` is exactly `"start"`/`"stop"`, ids are non-empty strings ≤128 chars, modelId ends `.gguf` (traversal rejected 400 — Review-Focus pin).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/gguf/__tests__/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/app/api/gguf/__tests__/routes.test.ts src/app/api/gguf/status/route.ts src/app/api/gguf/models/route.ts src/app/api/gguf/server/route.ts
git commit -m "feat(api): add GGUF status, models, and server routes

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: Registry schema — `gguf-model` kind + `gguf` block

**Files:**
- Modify: `src/lib/ai/provider-config/schema.ts` (kind enum line 43; add `GgufSettingsSchema` + optional `gguf` field on `ProviderEntrySchema`)
- Test: extend `src/lib/ai/provider-config/__tests__/schema.test.ts`
- Read-only check: `src/lib/ai/provider-config/migrate.ts` (confirm no migration needed — new kind only affects newly created entries; document the finding in a code comment only if a future reader could be confused, otherwise leave untouched)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProviderEntry.kind = "gguf-model"`, `entry.gguf?: { idleMinutes?, contextWindow?, ngl?, kvDtype?, extraFlags?, serverPath? }` for Tasks 4 (already written against this shape — compile Task 4 against it now), 7, 9.

- [ ] **Step 1: Write the failing tests** (append to schema.test.ts; follow its existing `validDoc` pattern)

```ts
it("round-trips a gguf-model provider with a gguf settings block", () => {
  const doc = {
    version: 1,
    providers: [
      {
        id: "gguf-local",
        kind: "gguf-model",
        name: "GGUF Local",
        baseUrl: "http://127.0.0.1:2301",
        gguf: { idleMinutes: 7, kvDtype: "q8_0" },
        models: [
          {
            modelId: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
            displayName: "Qwen2.5-7B-Instruct-Q4_K_M",
            capabilities: {
              contextWindow: 32768, maxOutputTokens: null,
              inputModalities: ["text"], outputModalities: ["text"],
              supportsToolCalls: null, supportsReasoning: null,
            },
            capabilitySources: {},
          },
        ],
      },
    ],
  };
  const parsed = RegistryDocumentSchema.parse(doc);
  expect(parsed.providers[0].kind).toBe("gguf-model");
  expect(parsed.providers[0].gguf).toMatchObject({ idleMinutes: 7, kvDtype: "q8_0" });
});

it("keeps absent idleMinutes absent (no Zod default shadows the dynamic default)", () => {
  const parsed = ProviderEntrySchema.parse({
    id: "g", kind: "gguf-model", name: "G", baseUrl: "http://127.0.0.1:2301", gguf: {},
  });
  expect(parsed.gguf).toEqual({});
  expect("idleMinutes" in (parsed.gguf ?? {})).toBe(false);
});

it("rejects out-of-range gguf overrides", () => {
  expect(() =>
    ProviderEntrySchema.parse({
      id: "g", kind: "gguf-model", name: "G", baseUrl: "http://127.0.0.1:2301",
      gguf: { idleMinutes: 0, extraFlags: Array.from({ length: 11 }, () => "x") },
    })
  ).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ai/provider-config/__tests__/schema.test.ts`
Expected: FAIL (kind enum rejects `"gguf-model"`).

- [ ] **Step 3: Write minimal implementation**

```ts
// in schema.ts, above ProviderEntrySchema:
export const GgufSettingsSchema = z.object({
  // NOTE: no defaults inside this block. Absent idleMinutes means "the
  // resource planner computes the size-based dynamic default"; a .default(5)
  // here would shadow it permanently. Persist only explicit user overrides.
  idleMinutes: z.number().int().min(1).max(60).optional(),
  contextWindow: z.number().int().min(2048).max(131072).optional(),
  ngl: z.number().int().min(0).max(100).optional(),
  kvDtype: z.enum(["auto", "f16", "q8_0"]).optional(),
  extraFlags: z.array(z.string().max(100)).max(10).optional(),
  serverPath: z.string().max(2048).optional(),
});
export type GgufSettings = z.infer<typeof GgufSettingsSchema>;
```

Add `kind: z.enum(["openai-compatible", "ollama", "gguf-model", "web-session"])` and `gguf: GgufSettingsSchema.optional()` to `ProviderEntrySchema`. Also extend `toViewEntry` in `store.ts` to pass `gguf` through to the view (add `...(entry.gguf ? { gguf: entry.gguf } : {})` and extend `ProviderEntryView` — check whether the view type needs the field; if `ProviderEntryView = Omit<ProviderEntry, "apiKeys"> & {...}` it already includes `gguf` automatically. Verify at implementation time and only touch store.ts if the type or runtime drops it — write a test asserting `getRegistryView` exposes `gguf` for a gguf entry).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ai/provider-config/__tests__/schema.test.ts`
Expected: PASS. Then compile the whole project: `npx tsc --noEmit` — Task 4's runner was written against `entry.gguf`; fix any type errors now (this is the integration point).

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/lib/ai/provider-config/schema.ts src/lib/ai/provider-config/store.ts src/lib/ai/provider-config/__tests__/schema.test.ts
git commit -m "feat(providers): add gguf-model kind and gguf settings block

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: Provider factory branch + async hook + all call sites

**Files:**
- Modify: `src/lib/ai/provider.ts`, `src/app/api/chat/route.ts` (2 resolution branches), `src/lib/ai/subagent-runner.ts` (`resolveModel`), `src/lib/ai/durable-model-step.ts` (`buildDurableModel`), `src/lib/ai/durable-model.ts` (keyless rebuild flag)
- Test: extend `src/lib/ai/__tests__/provider-factory.test.ts`

**Interfaces:**
- Consumes: `ensureGgufServerRunning` (Task 4), schema kind (Task 6).
- Produces: working generation path for gguf providers in chat, subagents, and durable workflows.

Context the implementer needs (verified this session): `createProviderInstance` (~provider.ts:147-166) branches ollama vs openai-compatible; `chatModelForEntry` (~194-208) is sync and short-circuits web-session; `getDefaultModel` (~258-275) rejects web-session defaults; chat route resolves keyless for `kind === "ollama"` and errors when `provider.apiKeyEnv && !apiKey`; `buildDurableModel` (durable-model-step.ts:29-61) returns `{ providerId, modelId, baseUrl, apiKey, isOllama }`; `DurableLanguageModel.resolve()` rebuilds via `createOpenAICompatible` with `name: isOllama ? "ollama" : provider`, `baseURL: isOllama ? baseUrl+/v1 : baseUrl`, `apiKey: isOllama ? "ollama" : apiKey`.

- [ ] **Step 1: Write the failing tests**

```ts
it("builds a gguf-model provider as keyless OpenAI-compatible with /v1 suffix", async () => {
  const entry = {
    id: "gguf-1", kind: "gguf-model", name: "GGUF",
    baseUrl: "http://127.0.0.1:2301", models: [],
  } as unknown as Parameters<typeof chatModelForEntry>[1];
  const model = await chatModelForEntry("m-7B.gguf", entry);
  expect(model).toBeDefined();
  expect(model.provider).toBe("gguf-1.chat");
});

it("starts the gguf server before building the model", async () => {
  const { ensureGgufServerRunning } = await import("@/lib/llama/runner");
  const mocked = vi.mocked(ensureGgufServerRunning);
  mocked.mockResolvedValueOnce("http://127.0.0.1:2301");
  const entry = {
    id: "gguf-1", kind: "gguf-model", name: "GGUF",
    baseUrl: "http://127.0.0.1:2301", models: [],
  } as unknown as Parameters<typeof chatModelForEntry>[1];
  await chatModelForEntry("m-7B.gguf", entry);
  expect(mocked).toHaveBeenCalledWith(entry, "m-7B.gguf");
});
```

Mock `@/lib/llama/runner` at the top of the test file with `vi.mock` returning `{ ensureGgufServerRunning: vi.fn(async () => "http://127.0.0.1:2301") }` so no real spawn occurs. Note `chatModelForEntry` is now async — update the three existing ollama/openai/bad-baseUrl tests to `await` (the throw test becomes `await expect(...).rejects.toThrow`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ai/__tests__/provider-factory.test.ts`
Expected: FAIL (`chatModelForEntry` is sync / kind unhandled — the ensure mock is never called).

- [ ] **Step 3: Write minimal implementation**

`provider.ts`:
```ts
function createProviderInstance(entry: ProviderEntry, apiKey?: string) {
  if (!entry.baseUrl) { /* unchanged error */ }
  const keyless = entry.kind === "ollama" || entry.kind === "gguf-model";
  return createOpenAICompatible({
    name: entry.kind === "ollama" ? "ollama" : (entry.id || entry.kind),
    baseURL: keyless ? `${entry.baseUrl.replace(/\/$/, "")}/v1` : entry.baseUrl,
    apiKey: entry.kind === "ollama" ? "ollama" : entry.kind === "gguf-model" ? "llamacpp" : (apiKey ?? undefined),
    supportsStructuredOutputs: true,
    fetch: /* unchanged rotating/sanitize logic */,
  });
}

export async function getProviderForEntry(entry: ProviderEntry) {
  const apiKey = entry.kind === "ollama" || entry.kind === "gguf-model"
    ? "llamacpp"
    : await resolveApiKey(entry);
  return createProviderInstance(entry, apiKey);
}

export async function chatModelForEntry(modelId, entry, apiKey?, session?) {
  if (entry.kind === "web-session") { /* unchanged */ }
  if (entry.kind === "gguf-model") {
    await ensureGgufServerRunning(entry, modelId);
  }
  const provider = createProviderInstance(entry, apiKey);
  return wrapLanguageModel({ /* unchanged */ });
}
```

Name choice: `entry.id || entry.kind` keeps the existing openai-compatible behavior (`entry.id || "openai-compatible"`) while giving gguf models a stable non-"openai-compatible" provider label — the factory test asserts `"gguf-1.chat"`. Keep the literal for openai-compatible to avoid changing existing assertions: `entry.kind === "ollama" ? "ollama" : (entry.id || "openai-compatible")` already yields `"gguf-1"` for our test entry, so NO name change is needed. Do not touch the name expression.

Call sites (make async-aware, treat gguf as keyless):
- `src/app/api/chat/route.ts` both branches: `provider.kind === "ollama"` → `provider.kind === "ollama" || provider.kind === "gguf-model"` in the three places per branch (keyless key, missing-key check, `chatModelForEntry` now awaited). That is 2 branches × (key ternary + guard + await) = 6 edits.
- `src/lib/ai/subagent-runner.ts` `resolveModel`: same keyless treatment + `await chatModelForEntry(...)` + ensure runs inside `chatModelForEntry` (import nothing new — the hook lives in the factory). Verify the web-session early-returns still precede it.
- `src/lib/ai/durable-model-step.ts`: `provider.kind === "ollama"` → include `"gguf-model"` in both the apiKey line and `isOllama`. The durable bundle cannot spawn servers (neutral VM, no node:*): document with a comment that gguf durable runs assume the server was warmed by a prior chat/subagent call, and `ensureGgufServerRunning` is deliberately NOT called here — instead call it in this step BEFORE returning (this step runs in Node, not the VM): add `if (provider.kind === "gguf-model") await ensureGgufServerRunning(provider, init.modelId);` after the model-entry check. Import from `@/lib/llama/runner` (step bundle allows Node access — that is the documented reason this module exists).
- `src/lib/ai/durable-model.ts`: extend `DurableModelInit` with `isGguf?: boolean`? No — reuse `isOllama` semantics would mislabel the provider name. Look at `resolve()`: `name: this.isOllama ? "ollama" : this.provider`. The provider NAME for gguf should be the registry id (matching the factory's `entry.id`), and baseURL needs the `/v1` suffix with dummy key. Add an `isKeyless`/`isGguf` boolean to `DurableModelInit`, thread it through constructor/serialization (the `toJSON`-style method at ~line 140), and branch `resolve()` identically to the factory: `baseURL: isKeyless ? baseUrl+/v1 : baseUrl`, `apiKey: isKeyless ? "llamacpp" : apiKey`, name stays `this.provider`. `buildDurableModel` sets it `provider.kind === "gguf-model"`. Write a round-trip test for the serialization including the new flag (find the existing durable-model serialization test and extend it in the same style).
- `getDefaultModel`: `await chatModelForEntry(...)` (gguf defaults are allowed — only web-session is rejected).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/ai/__tests__/provider-factory.test.ts`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean — every `chatModelForEntry` caller now awaits. If errors remain, they are missed call sites: fix them (search `chatModelForEntry` repo-wide).

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/lib/ai/provider.ts src/app/api/chat/route.ts src/lib/ai/subagent-runner.ts src/lib/ai/durable-model-step.ts src/lib/ai/durable-model.ts src/lib/ai/__tests__/provider-factory.test.ts
git commit -m "feat(providers): wire gguf-model kind through factory and call sites

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: Settings UI — Add GGUF Model button + badge

**Files:**
- Modify: `src/components/settings/tabs.tsx`
- Test: extend the provider-tab test (`provider-tab.test.tsx` — locate exact path at implementation time; spec names it `provider-tab.test.tsx`)

**Interfaces:**
- Consumes: `addGguf` handler prop (produced Task 9 — agree the prop name now: `addGguf: () => void`, mirroring `addOllama: () => void` at tabs.tsx:379).
- Produces: button + `GGUF` outline badge in the providers list.

- [ ] **Step 1: Write the failing tests**

```tsx
it("renders an Add GGUF Model button that calls addGguf", () => {
  render(<ProviderTab {...baseProps} addGguf={spy} />);
  fireEvent.click(screen.getByRole("button", { name: /add gguf model/i }));
  expect(spy).toHaveBeenCalledTimes(1);
});

it("shows a GGUF badge for gguf-model providers", () => {
  render(<ProviderTab {...baseProps} providers={[ggufProvider]} />);
  expect(screen.getByText("GGUF")).toBeInTheDocument();
});
```

Follow the file's existing render helpers/`baseProps` (read the top of the test file first; mirror the Ollama badge test at tabs.tsx ~482-486).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run <provider-tab test path>`
Expected: FAIL (no `addGguf` prop / no GGUF badge).

- [ ] **Step 3: Write minimal implementation** — add `addGguf: () => void` to the props interface (next to `addOllama`), render the button next to "Add Ollama" (line ~667-676) and "Add OpenAI-compatible" (~687), and render `<Badge variant="outline">GGUF</Badge>` next to the existing Ollama/OpenAI-compatible badge branch (~482-486). No other UI changes in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run <provider-tab test path>`
Expected: PASS.

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/components/settings/tabs.tsx <provider-tab test path>
git commit -m "feat(settings): add GGUF Model button and provider badge

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: Settings flow — addGguf dialog + per-provider resource section

**Files:**
- Modify: `src/components/settings-view.tsx`
- Test: extend `settings-api.test.ts` (gguf block persisted and read back) + component coverage for the add flow if the file has dialog tests to mirror (follow existing `addOllama` test style; do not invent a new harness).

**Interfaces:**
- Consumes: `GET /api/gguf/status`, `GET /api/gguf/models`, `GET/POST /api/gguf/server` (Task 5); `addGguf` prop (Task 8); `mapGgufHealth` display strings (Task 10 — Task 9 renders `RunnerStatus` fields directly; Task 10 only ADDS the health object to the server-route response, which this UI may ignore until a follow-up. No forward dependency.)
- Produces: end-to-end user flow from button to working gguf provider entry.

- [ ] **Step 1: Write the failing tests**

```ts
it("persists the gguf settings block and reads it back", async () => {
  // seed registry with a gguf-model provider carrying gguf: { idleMinutes: 7 },
  // PATCH /api/providers (or the settings save path the file already tests),
  // GET back, expect gguf.idleMinutes === 7.
});
```

Mirror `settings-api.test.ts`'s existing persist/read-back test for provider settings; only the payload changes. For the dialog flow (binary status row, scan list, over-memory badge, install banner with copyable `curl -LsSf https://llama.app/install.sh | sh`, path picker writing `gguf.serverPath`), follow the `addOllama` flow in settings-view.tsx (~895-975): fetch status + models, duplicate check on provider id, `addProvider` with `{ kind: "gguf-model", baseUrl: "http://127.0.0.1:2301", models: [{ modelId: <filename>, displayName: <stem> }] }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run <settings-api test path>`
Expected: FAIL (gguf block dropped or rejected).

- [ ] **Step 3: Write minimal implementation**
  - `addGguf` handler in settings-view: status fetch → install banner when `found: false` (copyable install command + `https://llama.app/` link + path picker persisting `gguf.serverPath`) → models fetch → fit-first list with size + over-memory badge + empty-state HuggingFace instructions (`mkdir -p data/models/GGUF-chatModel`) → select → create entry.
  - Expanded-provider resource section: computed flags read-only (`planned.args` joined, chosen KV dtype, ctx + shrink reason), editable overrides (context cap, KV dtype select auto/f16/q8_0, ngl with "manual only, no auto-detect" label, idle timeout, extra flags), Start now (`POST action:start`) / Stop now (`POST action:stop`) buttons, last-error display from `lastError`.
  - `displayName` = filename stem (strip trailing `.gguf` only).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run <settings-api test path>`
Expected: PASS. Manual sanity: `npm run dev`, add flow with and without binary present.

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/components/settings-view.tsx <settings-api test path>
git commit -m "feat(settings): add GGUF provider flow and resource section

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: Health mapping + footer vocabulary

**Files:**
- Modify: `src/lib/health/service-status.ts`, `src/app/api/gguf/server/route.ts` (attach mapped health to GET response)
- Test: `src/lib/health/__tests__/service-status.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `RunnerStatus` (Task 1).
- Produces: `mapGgufHealth` consumed by the server-route GET response.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { mapGgufHealth } from "@/lib/health/service-status";

describe("mapGgufHealth", () => {
  it("maps running → running/gguf-model", () => {
    expect(
      mapGgufHealth({ state: "running", pid: 1, planned: null, lastError: null }, "m-7B.gguf")
    ).toMatchObject({ status: "running", provider: "gguf-model", model: "m-7B.gguf" });
  });
  it("maps standby → standby with restart hint preserved", () => {
    expect(
      mapGgufHealth({ state: "standby", pid: null, planned: null, lastError: null }, "m.gguf")
    ).toMatchObject({ status: "standby", provider: "gguf-model" });
  });
  it("maps missing binary → unload + actionable provider string", () => {
    expect(
      mapGgufHealth({ state: "unload", pid: null, planned: null, lastError: "llama-server not installed" }, "m.gguf")
    ).toMatchObject({ status: "unload", provider: "llama-server not installed" });
  });
  it("maps OOM pre-check failure → unload + memory reason", () => {
    expect(
      mapGgufHealth({ state: "unload", pid: null, planned: null, lastError: "exceeds estimated usable memory (4.4 GB)" }, "m.gguf")
    ).toMatchObject({ status: "unload", provider: "model exceeds memory" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/health/__tests__/service-status.test.ts`
Expected: FAIL with resolve-import error (or file-not-found — create it in Step 3 alongside implementation; the "fail" is the missing export).

- [ ] **Step 3: Write minimal implementation**

```ts
/** Map GGUF runner state onto the shared footer vocabulary (mirrors mapRerankerHealth). */
export function mapGgufHealth(status: RunnerStatus, modelFile: string | null): ServiceHealth {
  const model = modelFile ? modelFile.replace(/\.gguf$/, "") : null;
  if (status.state === "running") {
    return { status: "running", provider: "gguf-model", model, loaded: true };
  }
  if (status.state === "standby") {
    return { status: "standby", provider: "gguf-model", model, loaded: false };
  }
  const reason = (status.lastError ?? "").toLowerCase();
  const provider = reason.includes("not installed")
    ? "llama-server not installed"
    : reason.includes("exceeds estimated usable memory") || reason.includes("insufficient free memory")
      ? "model exceeds memory"
      : "gguf-model";
  return { status: "unload", provider, model, loaded: false };
}
```

Extend `GET /api/gguf/server` response with `health: mapGgufHealth(status, modelId)`. No change to `use-system-health.ts` (spec: reuse vocabulary, no schema change).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/health/__tests__/service-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/lib/health/service-status.ts src/app/api/gguf/server/route.ts src/lib/health/__tests__/service-status.test.ts
git commit -m "feat(health): map GGUF runner state onto service vocabulary

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: Env-gated end-to-end integration test

**Files:**
- Create: `src/lib/llama/__tests__/gguf-server.integration.test.ts`

**Interfaces:**
- Consumes: real `llama-server` binary + tiny `.gguf` model. Skipped unless BOTH `LLAMA_TEST_BINARY` and `LLAMA_TEST_MODEL` are set (e.g. Qwen2.5-0.5B Q8_0 ~500MB).

- [ ] **Step 1: Write the test** (it is the test — no prior failing run needed beyond confirming skip behavior)

```ts
// src/lib/llama/__tests__/gguf-server.integration.test.ts
import { describe, it, expect } from "vitest";

const BINARY = process.env.LLAMA_TEST_BINARY;
const MODEL = process.env.LLAMA_TEST_MODEL;
const describeIf = BINARY && MODEL ? describe : describe.skip;

describeIf("gguf-server integration (env-gated)", () => {
  it("accepts planned flags, serves /health + /v1/models, completes a chat round-trip", async () => {
    const { planServerFlags } = await import("@/lib/llama/resource-planner");
    const { ensureGgufServerRunning, stopGgufServer } = await import("@/lib/llama/runner");
    const { stat } = await import("node:fs/promises");
    const sizeBytes = (await stat(MODEL!)).size;
    const planned = planServerFlags({
      filename: MODEL!.split("/").pop()!,
      modelSizeBytes: sizeBytes,
      modelCtxCap: null,
      profile: {
        cpuCores: (await import("node:os")).cpus().length,
        totalMemBytes: (await import("node:os")).totalmem(),
        freeMemBytes: (await import("node:os")).freemem(),
      },
    });
    expect(planned.args).toContain("--jinja"); // unknown-flag fallback did not strip a supported flag

    const entry = {
      id: "gguf-it", kind: "gguf-model", name: "GGUF IT",
      baseUrl: "http://127.0.0.1:2301",
      gguf: { serverPath: BINARY },
      models: [],
    } as unknown as Parameters<typeof ensureGgufServerRunning>[0];
    // NOTE: ensureGgufServerRunning resolves the model under data/models/GGUF-chatModel/;
    // for the integration run, copy/symlink LLAMA_TEST_MODEL there first (documented
    // in the test's header comment), then pass its basename as modelId.
    const modelId = MODEL!.split("/").pop()!;
    const baseUrl = await ensureGgufServerRunning(entry, modelId);
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.status).toBe("ok");
      const models = await (await fetch(`${baseUrl}/v1/models`)).json();
      expect(JSON.stringify(models)).toContain("gguf");
      const chat = await (
        await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Say ok." }], max_tokens: 16 }),
        })
      ).json();
      expect(chat.choices?.[0]?.message?.content?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await stopGgufServer("gguf-it", modelId);
    }
  }, 120_000);
});
```

Header comment in the file documents setup: symlink the tiny model into `data/models/GGUF-chatModel/`, set both env vars, run `npx vitest run src/lib/llama/__tests__/gguf-server.integration.test.ts`. Also assert `browseProviderModels("http://127.0.0.1:2301", undefined, "openai-compatible")` returns a non-empty list — this pins the `/models` compat assumption the providers/models route relies on (add the import + assertion in the same test).

- [ ] **Step 2: Run without env vars — verify skip**

Run: `npx vitest run src/lib/llama/__tests__/gguf-server.integration.test.ts`
Expected: PASS-as-skipped (0 run, 1 skipped). Then, if hardware + binary allow, run WITH env vars and record the outcome in the task report (a failure here blocks the release: it means the planner's flags or the `/health`+`/props` contract are wrong against the real server).

- [ ] **Step 3: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add src/lib/llama/__tests__/gguf-server.integration.test.ts
git commit -m "test(llama): add env-gated llama-server integration test

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: Changelog, full verification, self-review

**Files:**
- Modify: `CHANGELOG.md`
- Test: full suite + typecheck + lint.

- [ ] **Step 1: Add the CHANGELOG entry** under `[Unreleased]` → `Added`:

```md
## [Unreleased]

### Added
- New `GGUF Model` provider: run local `.gguf` chat models via a Yggdrasil-managed `llama-server` (fixed port 2301) with OOM-safe resource planning, idle auto-unload, and an Add GGUF Model flow in Settings → Providers. Place `.gguf` files in `data/models/GGUF-chatModel/`; install the server with `curl -LsSf https://llama.app/install.sh | sh`. (2026-09-30)
```

- [ ] **Step 2: Run the full verification**

Run: `npx vitest run`
Expected: all PASS (integration test skips without env vars).
Run: `npx tsc --noEmit`
Expected: clean.
Run: `npx eslint .`
Expected: clean (or only pre-existing warnings — confirm with `git stash`-free diff review: warnings on touched files must be zero).

- [ ] **Step 3: Self-review against the spec** (checklist, fix inline):
  1. Spec coverage: every spec section (planner formula/tiers/ordering/flags/idle; runner ports/spawn/orphan/idle/crash/flag-fallback; detect binary+scan; schema; provider.ts; UI button/badge/resource/footer; test table incl. integration) points to its task above. Gaps found → add the missing test/code now.
  2. Placeholder scan: no TBD/TODO/"similar to Task N"/ undescribed error handling. The `-m <model-path>` token replacement in Task 4 must be implemented, not left as a literal.
  3. Type consistency: `GgufOverrides` field names match the Zod block (`idleMinutes, contextWindow, ngl, kvDtype, extraFlags, serverPath`); `RunnerStatus` shape matches Task 10's consumer and Task 5's response; `ensureGgufServerRunning(entry, modelId)` signature identical everywhere.
  4. Review Focus: each of the five lines has its test (traversal → Task 4; extraFlags host/shell → Task 4; rogue serverPath binary → Task 4 props-verify test; garbage version → Task 3; foreign same-model port → Task 4 reassign test).

- [ ] **Step 4: Commit (only if explicitly authorized; otherwise skip)**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): add GGUF Model provider entry

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-30-gguf-model-provider.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **subagent-driven**, because the runner supervisor (Task 4) and the async factory migration (Task 7) touch process management and every generation call path, so independent per-task review is worth the cost. Does the plan capture what you want, and which approach should we use?
