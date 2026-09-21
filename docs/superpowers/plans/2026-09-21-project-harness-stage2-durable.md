# Project Harness Stage 2 — Durable Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Projects turn into Workflow DevKit so a task survives client disconnect and server restart, and resumes without re-applying tool side effects.

**Architecture:** The harness becomes two layers. A `"use workflow"` function builds a `WorkflowAgent` and calls `agent.stream({ writable: getWritable() })`; the agent's own steps (the model call in `doStreamStep`, and each tool whose `execute` carries `"use step"`) provide durability. A finalisation step converts `result.messages` (`ModelMessage[]`) to `UIMessage[]` via a new converter and persists them, so persistence no longer depends on a client being connected. The existing `streamText` route stays as a fallback behind `PROJECT_HARNESS_DURABLE`.

**Tech Stack:** TypeScript (strict), AI SDK v7 (`ai@7.0.97`), `@ai-sdk/workflow@2.0.28`, `workflow@5.0.0-beta.50` + `@workflow/vitest@5.0.0-beta.50`, Next.js 16.3.2, Drizzle/SQLite, Vitest 4, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-21-project-coding-harness-design.md` (Rev 8).

**Spike evidence (read before Task 2 and Task 3):** `docs/spikes/2026-09-21-workflow-gates/RESULTS.md`, `RESULTS-gate9-runtime.md`, `RESULTS-toolscontext.md`.

## Global Constraints

- Branch: `development`.
- **Stage 1 must be committed and observed first** (`2026-09-21-project-harness-stage1-hardening.md`). Do not start this plan until the landing-page task runs past six steps with a labelled stop reason.
- No `any`. No empty `catch` (log or rethrow).
- Do NOT change chat behaviour: `src/app/api/chat/route.ts`, `src/lib/ai/prepare-step.ts`, `src/lib/ai/termination-conditions.ts`, `src/lib/ai/context-budget.ts`. `harness-loop.ts` may gain exports but `createChatStopConditions()` behaviour must not change (pinned by a test in Task 9).
- Do NOT pass `abortSignal: req.signal` into any generation call.
- **`@workflow/vitest` must match the `workflow` major.** `4.x` fails against `workflow@5` (it transforms the runtime's own files and dies with `Functions marked with "use step" must be async functions`). Use `@workflow/vitest@5.0.0-beta.50`.
- Workflow functions live in their **own module**, never in a test file (the builder rejects `"use workflow"` inside a test callback).
- Workflow data stays inside the project: `WORKFLOW_LOCAL_DATA_DIR=data/workflow` (`data/` is already git-ignored — Rule 06).
- Tests: unit tests via `pnpm vitest run --project unit <file>`; workflow integration tests via a **separate** config with the `workflow()` plugin. Never run the full suite in parallel (Rule 18).
- `pnpm exec tsc --noEmit` must stay green at every task boundary.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `next.config.ts` | Wrap with `withWorkflow()` |
| Modify | `.gitignore` | Ignore `data/workflow/` (covered by `data/`, add explicitly for clarity) |
| Create | `src/lib/ai/durable-model.ts` | Serializable model class (protocol implemented, provider built inside) |
| Create | `src/workflows/project-harness-workflow.ts` | `"use workflow"` entry point |
| Create | `src/workflows/project-harness-steps.ts` | `"use step"` functions: model build, tool execution, finalisation |
| Create | `src/lib/ai/model-message-to-ui-message.ts` | Pure `ModelMessage[]` → `UIMessage[]` converter |
| Modify | `src/lib/project-harness-tools.ts` | `execute` becomes `"use step"`; options via serializable input |
| Modify | `src/db/schema.ts` | `project_sessions.active_run_id` |
| Modify | `src/db/init.ts` | `ensureColumn` for `active_run_id` |
| Modify | `src/lib/project-service.ts` | `claimProjectRun` / `releaseProjectRun` |
| Modify | `src/app/api/projects/chat/route.ts` | Flag branch; claim before `start()` |
| Create | `src/app/api/projects/chat/[runId]/stream/route.ts` | Reconnect endpoint |
| Modify | `src/components/projects/ProjectWorkspace.tsx` | Choose transport from the response header |
| Modify | `package.json` | `ai` bumped to `^7.0.97`; `@workflow/vitest` dev dependency |
| Create | `vitest.workflow.config.ts` | Vitest config with the `workflow()` plugin |

---

## Phase A — Foundation (gates 8 and 9; both block everything else)

### Task 1: Enable Workflow in the Next.js app

**Why:** `withWorkflow()` generates the route handlers that make `"use workflow"` and `"use step"` real. Without it, `start()` throws `'start' received an invalid workflow function`. Verified: this repo has **no** `src/middleware.ts` or `src/proxy.ts`, so no matcher exclusion is needed.

**Files:**
- Modify: `next.config.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a working Workflow runtime; every later task depends on it.

- [ ] **Step 1: Wrap the Next config**

Replace the default export in `next.config.ts`:

```ts
import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "onnxruntime-node"],
  experimental: {
    turbopackMemoryEviction: "full",
    optimizePackageImports: [
      "@phosphor-icons/react",
      "@xyflow/react",
      "shiki",
      "three",
      "@react-three/fiber",
      "@react-three/drei",
      "mermaid",
      "katex",
    ],
  },
};

export default withWorkflow(nextConfig);
```

- [ ] **Step 2: Keep workflow data inside the project**

Append to `.gitignore` (it is already covered by the `data/` entry, but state it explicitly so the isolation is visible):

```
# Workflow DevKit Local World run data (Rule 06: never outside the project)
data/workflow/
```

- [ ] **Step 3: Set the Local World data directory**

In `.env.local`, add:

```
WORKFLOW_LOCAL_DATA_DIR=data/workflow
```

Then add the same key with an explanatory comment to `.env.example` (the committed template — never a real secret):

```
# Workflow DevKit Local World storage. Must stay inside the project (Rule 06).
WORKFLOW_LOCAL_DATA_DIR=data/workflow
```

- [ ] **Step 4: Verify the build accepts the plugin**

Run: `pnpm exec tsc --noEmit`

Expected: no errors. Then run `pnpm build` and confirm it completes — this is where a `workflow`/Next incompatibility would surface first. If the build fails on the Workflow plugin, stop and report it: this is spec risk §7.3 and it blocks the whole plan.

- [ ] **Step 5: Commit**

```bash
git add next.config.ts .gitignore .env.example
git commit -m "chore(workflow): enable Workflow DevKit for the durable harness

Wraps next.config.ts with withWorkflow() and pins the Local World data
directory inside the project (data/workflow) per the isolation invariant.
No middleware matcher change is needed: this repo has no middleware.ts or
proxy.ts."
```

---

### Task 2: Gate 8 — a model that crosses the step boundary

**Why:** `doStreamStep` takes the model as its **second argument**, so the model must be serializable. The spikes proved: a `wrapLanguageModel` wrapper cannot cross (`SerializationError` at `.args[1].doGenerate`); a `node_modules` provider class is not auto-registered; a model **factory is never invoked** (`Unsupported model version undefined`); but a **locally-defined class implementing the serialization protocol crosses cleanly**. This task builds that class. It is gate 8 and it blocks every other Stage 2 task.

**Files:**
- Create: `src/lib/ai/durable-model.ts`
- Test: `src/lib/ai/__tests__/durable-model.test.ts`
- Create: `vitest.workflow.config.ts`

**Interfaces:**
- Consumes: `chatModelForEntry` semantics from `src/lib/ai/provider.ts` (provider id + model id + key), and the `provider-config` store's `loadRegistry` / `resolveApiKey`.
- Produces:

```ts
/** Serializable inputs the class needs; all plain data. */
export interface DurableModelInit {
  providerId: string;
  modelId: string;
  /** Env var name to read the key from — never the key value itself. */
  apiKeyEnv?: string;
}

export class DurableLanguageModel {
  constructor(init: DurableModelInit);
  static [WORKFLOW_SERIALIZE](instance: DurableLanguageModel): DurableModelInit;
  static [WORKFLOW_DESERIALIZE](init: DurableModelInit): DurableLanguageModel;
  readonly specificationVersion: "v4";
  readonly provider: string;
  readonly modelId: string;
  doStream(options: unknown): Promise<{ stream: ReadableStream<unknown> }>;
  doGenerate(options: unknown): Promise<unknown>;
}
```

`doStream`/`doGenerate` resolve the provider lazily on first call (inside the step) and delegate to it, applying `extractReasoningMiddleware` there — so the wrapper exists only inside the step and never crosses the boundary.

- [ ] **Step 1: Write the workflow Vitest config**

Create `vitest.workflow.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";

export default defineConfig({
  plugins: [workflow({ cwd: process.cwd() })],
  test: {
    include: ["src/**/*.workflow.test.ts"],
    testTimeout: 90_000,
    maxWorkers: 1,
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/ai/__tests__/durable-model.test.ts`. This test asserts the two properties the spike identified, without needing a live provider:

```ts
import { describe, it, expect } from "vitest";
import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";

const SERIALIZE = Symbol.for("workflow-serialize");
const DESERIALIZE = Symbol.for("workflow-deserialize");

const init: DurableModelInit = {
  providerId: "test-provider",
  modelId: "test-model",
  apiKeyEnv: "TEST_PROVIDER_KEY",
};

describe("DurableLanguageModel", () => {
  it("implements the workflow serialization protocol", () => {
    expect(typeof DurableLanguageModel[SERIALIZE]).toBe("function");
    expect(typeof DurableLanguageModel[DESERIALIZE]).toBe("function");
  });

  it("serializes to plain data only", () => {
    const serialized = DurableLanguageModel[SERIALIZE](
      new DurableLanguageModel(init)
    );
    expect(serialized).toEqual(init);
    // Must survive structured cloning: no functions, no class instances.
    expect(() => structuredClone(serialized)).not.toThrow();
  });

  it("round-trips back to an equivalent model", () => {
    const restored = DurableLanguageModel[DESERIALIZE](init);
    expect(restored).toBeInstanceOf(DurableLanguageModel);
    expect(restored.provider).toBe("test-provider");
    expect(restored.modelId).toBe("test-model");
  });

  it("exposes the V4 specification version the SDK requires", () => {
    expect(new DurableLanguageModel(init).specificationVersion).toBe("v4");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/durable-model.test.ts`

Expected: FAIL — cannot resolve `@/lib/ai/durable-model`.

- [ ] **Step 4: Implement the class**

Create `src/lib/ai/durable-model.ts`:

```ts
import { extractReasoningMiddleware, wrapLanguageModel } from "ai";
import { loadRegistry, resolveApiKey } from "@/lib/ai/provider-config/store";
import { chatModelForEntry } from "@/lib/ai/provider";

const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

/** Serializable inputs. Plain data only — this crosses the step boundary. */
export interface DurableModelInit {
  providerId: string;
  modelId: string;
  /** Env var name to read the key from — never the key value itself. */
  apiKeyEnv?: string;
}

/**
 * A language model that survives the Workflow step boundary.
 *
 * `WorkflowAgent` passes the model as an argument to its `doStreamStep`, so the
 * model must be serializable. Two shapes cannot cross: a `wrapLanguageModel`
 * result (its `doGenerate`/`doStream` are functions) and a bare provider class
 * from `node_modules` (the SWC plugin derives class ids from file paths, so a
 * `node_modules` class is never registered). This class is defined locally, so
 * it *is* discovered and registered, and it serializes to plain data only.
 *
 * The real provider — and the reasoning middleware wrapper — are built lazily
 * on first use, inside the step, so neither ever crosses the boundary.
 */
export class DurableLanguageModel {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  private readonly apiKeyEnv?: string;
  private resolved?: ReturnType<typeof wrapLanguageModel>;

  constructor(init: DurableModelInit) {
    this.provider = init.providerId;
    this.modelId = init.modelId;
    this.apiKeyEnv = init.apiKeyEnv;
  }

  static [WORKFLOW_SERIALIZE](instance: DurableLanguageModel): DurableModelInit {
    return {
      providerId: instance.provider,
      modelId: instance.modelId,
      apiKeyEnv: instance.apiKeyEnv,
    };
  }

  static [WORKFLOW_DESERIALIZE](init: DurableModelInit): DurableLanguageModel {
    return new DurableLanguageModel(init);
  }

  /**
   * Builds the underlying provider on first call. This runs inside the step,
   * where full Node.js access is available, so reading the registry and the
   * environment is legal here and nowhere else.
   */
  private async resolve(): Promise<ReturnType<typeof wrapLanguageModel>> {
    if (this.resolved) return this.resolved;

    const doc = await loadRegistry();
    const provider = doc.providers.find((p) => p.id === this.provider);
    if (!provider) {
      throw new Error(
        `Durable model: provider "${this.provider}" is not in the registry.`
      );
    }
    const model = provider.models.find((m) => m.modelId === this.modelId);
    if (!model) {
      throw new Error(
        `Durable model: model "${this.modelId}" is not in provider "${provider.name}".`
      );
    }

    const apiKey =
      provider.kind === "ollama" ? undefined : await resolveApiKey(provider);
    if (provider.kind !== "ollama" && provider.apiKeyEnv && !apiKey) {
      throw new Error(
        `Durable model: API key not set for ${provider.name} (${provider.apiKeyEnv}).`
      );
    }

    this.resolved = wrapLanguageModel({
      model: chatModelForEntry(this.modelId, provider, apiKey),
      middleware: extractReasoningMiddleware({ tagName: "think" }),
    });
    return this.resolved;
  }

  async doStream(options: unknown) {
    const model = await this.resolve();
    return model.doStream(options as never);
  }

  async doGenerate(options: unknown) {
    const model = await this.resolve();
    return model.doGenerate(options as never);
  }
}
```

**Note on the `as never` casts:** they exist only because the SDK's option types are generic over the prompt shape, which this class does not narrow. If `tsc` accepts the call without them once the file compiles, remove them. Do not introduce `any`.

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/durable-model.test.ts`

Expected: PASS — four tests.

- [ ] **Step 6: Write the workflow-level test that proves it crosses**

Create `src/workflows/durable-model.workflow.test.ts` (the `*.workflow.test.ts` suffix is what `vitest.workflow.config.ts` includes). The workflow must be in its own module — put it in `src/workflows/durable-model-probe.ts`:

```ts
// src/workflows/durable-model-probe.ts
import { getWritable } from "workflow";
import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";

/** Returns whatever the model reports, proving it survived the boundary. */
export async function durableModelProbeWorkflow(init: DurableModelInit) {
  "use workflow";
  const model = new DurableLanguageModel(init);
  const info = await reportModel(model);
  return info;
}

async function reportModel(model: DurableLanguageModel) {
  "use step";
  // Reaching this line at all means the instance deserialized inside the step.
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
  };
}
```

```ts
// src/workflows/durable-model.workflow.test.ts
import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { durableModelProbeWorkflow } from "./durable-model-probe";

describe("DurableLanguageModel across the step boundary", () => {
  it("deserializes inside a step", async () => {
    const run = await start(durableModelProbeWorkflow, [
      { providerId: "p", modelId: "m", apiKeyEnv: "K" },
    ]);
    await expect(run.returnValue).resolves.toEqual({
      specificationVersion: "v4",
      provider: "p",
      modelId: "m",
    });
  });
});
```

Run: `pnpm vitest run --config vitest.workflow.config.ts src/workflows/durable-model.workflow.test.ts`

Expected: PASS. If it fails with `Class "…" not found`, the class is not being discovered — check that the file is inside `src/` and that the import is a value import (not `import type`).

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/durable-model.ts src/lib/ai/__tests__/durable-model.test.ts \
        src/workflows/durable-model-probe.ts src/workflows/durable-model.workflow.test.ts \
        vitest.workflow.config.ts
git commit -m "feat(workflow): add a language model that crosses the step boundary

WorkflowAgent passes the model as an argument to doStreamStep, so it must
be serializable. A wrapLanguageModel result cannot cross (its methods are
functions), a node_modules provider class is never registered, and a model
factory is never invoked. This locally-defined class implements the
workflow serialization protocol and builds the provider and the reasoning
middleware lazily inside the step, so neither crosses the boundary."
```

---

### Task 3: Gate 9 — confirm `toolsContext` reaches `execute`

**Why:** three spikes could not observe this. The source is unambiguous (`resolveToolContext` returns `toolsContext[toolName]` verbatim when the tool declares no `contextSchema`, and the call site passes `context: await resolvedContext`), but it was never seen end to end. **This task answers it against a real turn — do not build another mock.** If it fails, §3.4/§3.6.3/§4.3/§3.8 of the spec need rework before Task 9.

**Files:**
- Create: `src/workflows/tools-context-probe.ts`
- Create: `src/workflows/tools-context.workflow.test.ts`

**Interfaces:**
- Consumes: `DurableLanguageModel` from Task 2.
- Produces: a recorded verdict. If `toolsContext` arrives, Task 9 wires tools as `"use step"` functions fed by `toolsContext`. If it does not, **stop and report** — do not improvise a workaround.

- [ ] **Step 1: Write the probe workflow**

Create `src/workflows/tools-context-probe.ts`. It uses the real `DurableLanguageModel` with a **configured** provider (so a real turn completes), and one tool whose `execute` carries `"use step"` and records its `context`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";

/** What the tool observed. Returned so the test can assert on it. */
let observed: unknown = null;

async function probeExecute(
  input: { note: string },
  options: { context?: unknown } = {}
) {
  "use step";
  observed = { input, context: options.context ?? null };
  return { ok: true, gotContext: options.context !== undefined };
}

export async function toolsContextProbeWorkflow(
  init: DurableModelInit,
  prompt: string
) {
  "use workflow";
  observed = null;

  const agent = new WorkflowAgent({
    model: new DurableLanguageModel(init) as never,
    instructions:
      "Call the probe tool exactly once with note='hello', then stop.",
    tools: {
      probe: tool({
        description: "Records the context it receives.",
        inputSchema: z.object({ note: z.string() }),
        execute: probeExecute,
      }),
    } as never,
    toolsContext: {
      probe: { canonicalRoot: "/tmp/probe-root", sessionId: "sess_probe" },
    } as never,
    stopWhen: isStepCount(4),
  });

  const result = await agent.stream({
    messages: [{ role: "user", content: prompt }],
    writable: getWritable(),
  });

  return {
    finishReason: result.finishReason,
    observed,
  };
}
```

Add `isStepCount` to the `ai` import.

- [ ] **Step 2: Write the test**

Create `src/workflows/tools-context.workflow.test.ts`. It needs a real provider, so it reads the registry the same way the app does:

```ts
import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { loadRegistry } from "@/lib/ai/provider-config/store";
import { toolsContextProbeWorkflow } from "./tools-context-probe";

describe("toolsContext reaches tool execute", () => {
  it("passes the per-tool entry as `context`", async () => {
    const doc = await loadRegistry();
    const provider = doc.providers.find((p) => p.models.length > 0);
    if (!provider) {
      throw new Error(
        "No provider configured. Add one in Settings → Providers to run gate 9."
      );
    }
    const model = provider.models[0];

    const run = await start(toolsContextProbeWorkflow, [
      {
        providerId: provider.id,
        modelId: model.modelId,
        apiKeyEnv: provider.apiKeyEnv,
      },
      "Call the probe tool now.",
    ]);
    const out = await run.returnValue;

    // The verdict this whole task exists to produce:
    expect(out.observed).not.toBeNull();
    expect(out.observed).toMatchObject({
      context: { canonicalRoot: "/tmp/probe-root", sessionId: "sess_probe" },
    });
  }, 120_000);
});
```

- [ ] **Step 3: Run the probe**

Run: `pnpm vitest run --config vitest.workflow.config.ts src/workflows/tools-context.workflow.test.ts`

Expected: PASS, proving `toolsContext` arrives. Record the outcome in the commit message.

**If it FAILS:** do not work around it. Report the failure and stop — spec §3.4 states there is no accepted-loss fallback here, and §3.4/§3.6.3/§4.3/§3.8 would need rework before proceeding.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/tools-context-probe.ts src/workflows/tools-context.workflow.test.ts
git commit -m "test(workflow): confirm toolsContext reaches tool execute (gate 9)

Three spikes could not observe this: every attempt died at the model
before a tool ran. With the serializable model from the previous commit a
real turn completes, and the tool's execute records the per-tool entry
passed as `context`."
```

---

## Phase B — Data

### Task 4: An active-run pointer on the session

**Why:** the durable path needs its own single-run lock. `activeStreamId` is a resume pointer into the in-process registry and is still used by the chat path, so the Projects durable path gets a separate column.

**Files:**
- Modify: `src/db/schema.ts:296-312` (`projectSessions`)
- Modify: `src/db/init.ts` (the `ensureColumn` block at ~line 237)
- Modify: `src/lib/project-service.ts` (add claim/release beside the stream helpers at ~line 716)
- Test: `src/lib/__tests__/project-service.test.ts`

**Interfaces:**
- Consumes: the existing `claimProjectSessionStream` pattern (conditional `UPDATE … WHERE … IS NULL`).
- Produces:

```ts
export function claimProjectRun(
  sessionId: string,
  runId: string,
  isRunLive: (existingRunId: string) => boolean,
  db?: AppDatabase
): boolean;

export function releaseProjectRun(
  sessionId: string,
  expectedRunId: string,
  db?: AppDatabase
): boolean;
```

`isRunLive` is injected so the caller can reconcile a stale pointer with `getRun()` without `project-service.ts` depending on the Workflow runtime.

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, inside `projectSessions`, after `activeStreamId`:

```ts
    activeStreamId: text("active_stream_id"),
    // Durable-run pointer for the Projects harness (spec §4.5). Separate from
    // activeStreamId, which remains the in-process registry pointer for the
    // chat path. At most one of the two is ever set for a session.
    activeRunId: text("active_run_id"),
```

- [ ] **Step 2: Add the idempotent migration**

In `src/db/init.ts`, in the `ensureColumn` block (after the existing `project_sessions` entries):

```ts
  // Durable-run pointer for the Projects harness (spec §4.5).
  ensureColumn(sqlite, "project_sessions", "active_run_id", "TEXT");
```

Also add the column to the `CREATE TABLE IF NOT EXISTS project_sessions` block so fresh databases get it directly — insert after `active_stream_id TEXT,`:

```sql
      active_run_id TEXT,
```

- [ ] **Step 3: Write the failing test**

Add to `src/lib/__tests__/project-service.test.ts`, following the file's existing setup for creating a project and session:

```ts
describe("claimProjectRun / releaseProjectRun", () => {
  it("claims a free run slot", () => {
    expect(claimProjectRun(sessionId, "wrun_1", () => true)).toBe(true);
  });

  it("refuses a second claim while a live run holds the slot", () => {
    expect(claimProjectRun(sessionId, "wrun_2", () => true)).toBe(false);
  });

  it("reclaims when the recorded run is no longer live", () => {
    // A run that finished, failed, was cancelled, or was pruned: the pointer
    // is unusable, so a new claim must be allowed (spec §4.5 leak cases).
    expect(claimProjectRun(sessionId, "wrun_3", () => false)).toBe(true);
  });

  it("releases only the matching run", () => {
    expect(releaseProjectRun(sessionId, "wrun_not_current")).toBe(false);
    expect(releaseProjectRun(sessionId, "wrun_3")).toBe(true);
  });
});
```

Import `claimProjectRun` and `releaseProjectRun` alongside the existing imports.

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/__tests__/project-service.test.ts -t "claimProjectRun"`

Expected: FAIL — `claimProjectRun is not a function`.

- [ ] **Step 5: Implement claim and release**

In `src/lib/project-service.ts`, mirroring `claimProjectSessionStream`/`releaseProjectSessionStream` exactly:

```ts
/**
 * Atomically claim the durable-run slot for a session.
 *
 * The claim is a conditional UPDATE (`active_run_id IS NULL`), so two
 * concurrent requests cannot both win — the same technique as
 * {@link claimProjectSessionStream}. `isRunLive` reconciles a stale pointer:
 * a run that finished, failed, was cancelled, or was pruned leaves a value the
 * Workflow runtime no longer knows, and without reconciliation the session
 * would be locked forever (spec §4.5).
 *
 * @returns true when the claim succeeded.
 */
export function claimProjectRun(
  sessionId: string,
  runId: string,
  isRunLive: (existingRunId: string) => boolean,
  db: AppDatabase = defaultDb
): boolean {
  const claim = () =>
    db
      .update(projectSessions)
      .set({ activeRunId: runId, updatedAt: new Date() })
      .where(
        and(
          eq(projectSessions.id, sessionId),
          isNull(projectSessions.activeRunId)
        )
      )
      .run();

  const reclaimed = () =>
    db
      .update(projectSessions)
      .set({ activeRunId: runId, updatedAt: new Date() })
      .where(eq(projectSessions.id, sessionId))
      .run();

  const current = db
    .select({ activeRunId: projectSessions.activeRunId })
    .from(projectSessions)
    .where(eq(projectSessions.id, sessionId))
    .get();

  if (!current) return false;

  if (current.activeRunId === null) {
    return claim().changes > 0;
  }

  if (isRunLive(current.activeRunId)) {
    return false;
  }

  return reclaimed().changes > 0;
}

/**
 * Release the durable-run slot, but only if it still points at `expectedRunId`.
 *
 * The guard matters: a later request may already hold a new run, and a blind
 * release would clobber it (mirrors {@link releaseProjectSessionStream}).
 */
export function releaseProjectRun(
  sessionId: string,
  expectedRunId: string,
  db: AppDatabase = defaultDb
): boolean {
  const result = db
    .update(projectSessions)
    .set({ activeRunId: null, updatedAt: new Date() })
    .where(
      and(
        eq(projectSessions.id, sessionId),
        eq(projectSessions.activeRunId, expectedRunId)
      )
    )
    .run();
  return result.changes > 0;
}
```

Check the existing helpers for the exact import names (`isNull` may need adding to the `drizzle-orm` import) and the return-shape convention (`.run()` vs `.all()`), and match them.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit src/lib/__tests__/project-service.test.ts`

Expected: PASS — the new block plus the existing tests.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/init.ts src/lib/project-service.ts src/lib/__tests__/project-service.test.ts
git commit -m "feat(projects): add a durable-run pointer to project sessions

Separate from active_stream_id, which stays the in-process registry
pointer for the chat path. The claim is a conditional UPDATE, and a stale
pointer (run finished, failed, cancelled, or pruned) is reclaimed through
an injected isRunLive predicate so project-service does not depend on the
Workflow runtime."
```

---

### Task 5: A `ModelMessage[]` → `UIMessage[]` converter

**Why:** `WorkflowAgent` returns `result.messages` as `ModelMessage[]`, `collectUIMessages` is gone, and there is no built-in inverse. Persistence therefore needs this converter (spec §4.4b). It must round-trip **every** part type the route emits — including HMAC-signed approval parts, because dropping a signature would silently break `convertToModelMessages()` on the next turn.

**Files:**
- Create: `src/lib/ai/model-message-to-ui-message.ts`
- Test: `src/lib/ai/__tests__/model-message-to-ui-message.test.ts`

**Interfaces:**
- Consumes: `ModelMessage`, `UIMessage` types from `ai`.
- Produces:

```ts
export function modelMessagesToUIMessages(
  messages: ModelMessage[],
  options: { generateId: () => string }
): UIMessage[];
```

Ids are injected so the function stays pure and testable.

- [ ] **Step 1: Write the failing test with real fixtures**

Create `src/lib/ai/__tests__/model-message-to-ui-message.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { modelMessagesToUIMessages } from "@/lib/ai/model-message-to-ui-message";

let seq = 0;
const generateId = () => `id_${++seq}`;

describe("modelMessagesToUIMessages", () => {
  it("maps a user text message", () => {
    const input: ModelMessage[] = [{ role: "user", content: "hello" }];
    const out = modelMessagesToUIMessages(input, { generateId });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(out[0].parts).toContainEqual({ type: "text", text: "hello" });
  });

  it("maps assistant text", () => {
    const input: ModelMessage[] = [{ role: "assistant", content: "hi there" }];
    const out = modelMessagesToUIMessages(input, { generateId });
    expect(out[0].role).toBe("assistant");
    expect(out[0].parts).toContainEqual({ type: "text", text: "hi there" });
  });

  it("maps a tool call and its result into one assistant turn", () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "bash",
            output: { type: "text", value: "file.txt" },
          },
        ],
      },
    ];
    const out = modelMessagesToUIMessages(input, { generateId });
    const parts = out.flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "tool-bash", toolCallId: "call_1" })
    );
  });

  it("preserves an approval signature part", () => {
    // If this part is dropped, convertToModelMessages() on the next turn
    // silently loses the signature and the approval gate fails open.
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-approval-request",
            approvalId: "appr_1",
            toolCallId: "call_1",
            signature: "hmac_signature_value",
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const out = modelMessagesToUIMessages(input, { generateId });
    const parts = out.flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-approval-request",
        approvalId: "appr_1",
        signature: "hmac_signature_value",
      })
    );
  });

  it("assigns a unique id to every message", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const out = modelMessagesToUIMessages(input, { generateId });
    expect(new Set(out.map((m) => m.id)).size).toBe(out.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/model-message-to-ui-message.test.ts`

Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Implement the converter**

Create `src/lib/ai/model-message-to-ui-message.ts`. Derive the exact part shapes from what the route already produces — inspect `toUIMessageStream`'s output shape in the installed SDK (`grep -n "tool-${" node_modules/ai/dist/index.js | head`) and mirror it:

```ts
import type { ModelMessage, UIMessage, UIMessagePart } from "ai";

/** Options for {@link modelMessagesToUIMessages}. */
export interface ModelMessagesToUIMessagesOptions {
  /** Injected so the converter stays pure and testable. */
  generateId: () => string;
}

/**
 * Converts the model-message transcript an agent returns into UI messages for
 * persistence.
 *
 * `WorkflowAgent` returns `ModelMessage[]`, `collectUIMessages` no longer
 * exists, and the SDK ships no inverse — so the durable path needs its own.
 *
 * Every part type the Projects route can emit must round-trip, not just text
 * and tool calls: an approval request carries the HMAC signature that
 * `convertToModelMessages()` verifies on the *next* turn, so dropping it would
 * fail the approval gate silently rather than loudly.
 */
export function modelMessagesToUIMessages(
  messages: ModelMessage[],
  options: ModelMessagesToUIMessagesOptions
): UIMessage[] {
  return messages.map((message) => ({
    id: options.generateId(),
    role: message.role,
    parts: contentToParts(message.content),
  })) as UIMessage[];
}

/** Normalizes string content and passes structured parts through unchanged. */
function contentToParts(content: ModelMessage["content"]): UIMessagePart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }] as UIMessagePart[];
  }
  return content as UIMessagePart[];
}
```

**Important:** the two casts are a starting point, not the finished article. Run the tests and the type-checker, then replace each cast with the real narrowing the SDK expects — the `tool-result` → `tool-<name>` part mapping in particular needs to match what `toUIMessageStream` produces, or persisted history will render wrong. Do not leave a cast that hides a shape mismatch: the approval-signature test exists precisely to catch that.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/model-message-to-ui-message.test.ts`

Expected: PASS — five tests. Iterate on the mapping (not on the tests) until they do.

- [ ] **Step 5: Type-check**

Run: `pnpm exec tsc --noEmit`

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/model-message-to-ui-message.ts src/lib/ai/__tests__/model-message-to-ui-message.test.ts
git commit -m "feat(ai): convert ModelMessage[] back to UIMessage[] for persistence

WorkflowAgent returns ModelMessage[] and the SDK ships no inverse, so the
durable path cannot reuse toUIMessageStream's onEnd for persistence. This
converter round-trips every part type the route emits, including
approval-request parts and their HMAC signature — dropping a signature
would fail the approval gate silently on the next turn."
```

---

## Phase C — The durable harness

### Task 6: Gate 5 — the chunk watchdog on the durable path

**Why:** `WorkflowAgent.stream()` accepts `timeout?: number` — a single number, not the `HARNESS_TIMEOUT` object — so `stepMs`/`firstChunkMs`/`chunkMs` have no direct equivalent, and Stage 1's anti-silent guarantee does not carry over by configuration (spec §3.7). The spike showed a wrapped model cannot cross the step boundary, so the watchdog must be built **inside the same step that builds the model**. Spec §3.7 requires either a working middleware watchdog or a written accepted loss — this task produces one of the two, explicitly.

**Files:**
- Modify: `src/lib/ai/durable-model.ts`
- Test: `src/lib/ai/__tests__/durable-model.test.ts`

**Interfaces:**
- Consumes: `DurableLanguageModel` (Task 2), `HARNESS_TIMEOUT.chunkMs` (Stage 1).
- Produces: either a watchdog that aborts a stalled stream, or a documented accepted loss recorded in the spec. **Do not leave this undecided** — a silent omission here is what spec §3.7 forbids.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/ai/__tests__/durable-model.test.ts`. The watchdog must abort when no output chunk arrives within `chunkMs`, without a live provider:

```ts
describe("chunk watchdog", () => {
  it("aborts a stream that emits nothing within chunkMs", async () => {
    const model = new DurableLanguageModel(
      { providerId: "p", modelId: "m" },
      { chunkMs: 50 }
    );
    // A stream that never produces a chunk.
    const stalled = new ReadableStream<never>({
      start() {
        /* never enqueue, never close */
      },
    });
    const guarded = model.guardChunkGap(stalled);
    const reader = guarded.getReader();
    await expect(reader.read()).rejects.toThrow(/chunk/i);
  });

  it("passes chunks through while they keep arriving", async () => {
    const model = new DurableLanguageModel(
      { providerId: "p", modelId: "m" },
      { chunkMs: 1_000 }
    );
    const stream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const chunk of model.guardChunkGap(stream) as ReadableStream<string>) {
      out.push(chunk);
    }
    expect(out).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/durable-model.test.ts -t "chunk watchdog"`

Expected: FAIL — `model.guardChunkGap is not a function`.

- [ ] **Step 3: Implement the watchdog**

In `src/lib/ai/durable-model.ts`, extend the constructor with an optional watchdog config (defaulting to `HARNESS_TIMEOUT.chunkMs`) and add the guard:

```ts
import { HARNESS_TIMEOUT } from "@/lib/ai/harness-loop";

export interface DurableModelOptions {
  /** Gap between output chunks before the stream is treated as dead. */
  chunkMs?: number;
}

/**
 * Wraps a model stream so a genuine stall is detected.
 *
 * `WorkflowAgent` exposes only a single `timeout` number, so Stage 1's
 * per-gap `chunkMs` watchdog has no direct equivalent on the durable path.
 * This reimplements it: the timer re-arms on every chunk and fires only when
 * the gap exceeds `chunkMs`, which is what distinguishes a dead socket from a
 * reasoning model that is simply thinking (reasoning deltas are chunks).
 *
 * It lives on the model class, not in workflow state, because a wrapped model
 * is a live object and cannot cross the step boundary — the guard must be
 * built in the same step as the model it guards.
 */
guardChunkGap<T>(stream: ReadableStream<T>): ReadableStream<T> {
  const chunkMs = this.chunkMs;
  return new ReadableStream<T>({
    start(controller) {
      const reader = stream.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          reader.cancel().catch(() => undefined);
          controller.error(
            new Error(`Chunk timeout of ${chunkMs}ms exceeded — stream stalled.`)
          );
        }, chunkMs);
      };

      const pump = async () => {
        arm();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            arm();
            controller.enqueue(value);
          }
          if (timer) clearTimeout(timer);
          controller.close();
        } catch (err) {
          if (timer) clearTimeout(timer);
          controller.error(err);
        }
      };

      void pump();
    },
    cancel() {
      return stream.cancel();
    },
  });
}
```

Wire it into `doStream`:

```ts
async doStream(options: unknown) {
  const model = await this.resolve();
  const result = await model.doStream(options as never);
  return { ...result, stream: this.guardChunkGap(result.stream) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/durable-model.test.ts`

Expected: PASS — all tests.

- [ ] **Step 5: Record the outcome in the spec**

If the watchdog works, replace spec §3.7's "Decision" paragraph's alternative with the confirmed mechanism. If it cannot be made to work (for example the SDK wraps the stream again downstream), **do not delete the requirement** — write the accepted loss into §3.7 explicitly and note that the durable path relies on `totalMs` alone. This step exists because §3.7 makes "a silent omission" the one unacceptable outcome.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/durable-model.ts src/lib/ai/__tests__/durable-model.test.ts \
        docs/superpowers/specs/2026-09-21-project-coding-harness-design.md
git commit -m "feat(workflow): reimplement the chunk watchdog on the durable path

WorkflowAgent exposes only a single timeout number, so Stage 1's per-gap
chunkMs watchdog does not carry over. It is reimplemented on the model
class — which must live in the same step as the model, since a wrapped
model cannot cross the step boundary."
```

---

### Task 7: Gate 1 — approval equivalence

**Why:** spec §7.4 gate 1, and §3.3 claims approval is preserved through `WorkflowAgent`'s `experimental_toolApprovalSecret` + `needsApproval`. That claim is **unverified**: the current route uses `experimental_toolApprovalSecret` with `streamText`, and `tool-policy.ts` decides which calls need approval. Moving to `WorkflowAgent` changes the surface. The spec states this gate has no accepted-loss fallback, so it must be settled before the durable path is enabled.

**Files:**
- Modify: `src/workflows/project-harness-workflow.ts`
- Modify: `src/lib/project-harness-tools.ts` (add `needsApproval` to the destructive tools)
- Test: `src/lib/ai/__tests__/tool-policy.test.ts` (existing, if present) or `src/lib/project-harness-tools.test.ts`

**Interfaces:**
- Consumes: `evaluateToolApproval(toolName, input)` from `src/lib/ai/tool-policy.ts` (existing).
- Produces: destructive tools gated by `needsApproval` with the same predicate the route uses today, and a test pinning equivalence.

- [ ] **Step 1: Read what the current gate does**

Run: `grep -n "evaluateToolApproval" -A20 src/lib/ai/tool-policy.ts | head -40`

Note the exact predicate: which tool names and which input verbs trigger approval. This is the behaviour that must be preserved, not re-invented.

- [ ] **Step 2: Write the failing equivalence test**

Add a test that pins the durable gate to the same predicate the fallback uses:

```ts
describe("durable approval gate", () => {
  it("requires approval for a destructive bash command", async () => {
    const needs = await evaluateToolApproval("bash", { command: "rm -rf build" });
    expect(needs).toBe(true);
  });

  it("does not require approval for a read-only command", async () => {
    const needs = await evaluateToolApproval("bash", { command: "ls -la" });
    expect(needs).toBe(false);
  });

  it("uses the same predicate the durable tools declare", () => {
    // The workflow's tools must not carry a second, divergent policy.
    const { bashToolNeedsApproval } = require("@/lib/project-harness-tools");
    expect(bashToolNeedsApproval({ command: "rm -rf build" })).toBe(
      evaluateToolApproval("bash", { command: "rm -rf build" })
    );
  });
});
```

Run it: `pnpm vitest run --project unit src/lib/project-harness-tools.test.ts -t "durable approval gate"`

Expected: FAIL — `bashToolNeedsApproval` does not exist.

- [ ] **Step 3: Express the gate once**

In `src/lib/project-harness-tools.ts`, export a single predicate that both the tool definition and any test use:

```ts
import { evaluateToolApproval } from "@/lib/ai/tool-policy";

/**
 * Approval predicate for the bash tool, delegating to the shared policy so the
 * durable path cannot drift from the fallback path. Exported for the
 * equivalence test; the tool below references this same function.
 */
export const bashToolNeedsApproval = (input: { command: string }) =>
  evaluateToolApproval("bash", input);
```

Attach it to the durable tool definition in the workflow:

```ts
bash: tool({
  description: /* unchanged */,
  inputSchema: /* unchanged */,
  needsApproval: bashToolNeedsApproval,
  execute: projectBashStep,
}),
```

Repeat for `file_operations` write/edit and any other destructive tool, each delegating to `evaluateToolApproval` with its own name.

- [ ] **Step 4: Configure the signing secret**

In the workflow, pass the approval secret **by environment variable name**, never the value (spec §3.3):

```ts
const agent = new WorkflowAgent({
  // …
  experimental_toolApprovalSecret: { environmentVariable: "TOOL_APPROVAL_SECRET" },
});
```

Add `TOOL_APPROVAL_SECRET` to `.env.example` with a comment stating it must be at least 32 bytes and present on every worker, and that rotating it invalidates pending approvals.

- [ ] **Step 5: Run the tests and type-check**

Run: `pnpm vitest run --project unit src/lib/project-harness-tools.test.ts && pnpm exec tsc --noEmit`

Expected: PASS, no type errors.

- [ ] **Step 6: Verify the anti-forgery property**

Write a workflow-level test that approves a gated tool and asserts the tool executed, then replays the same approval with a tampered signature and asserts it did **not**. Use `addToolApprovalResponse` as the SDK documents. If the tampered case executes, the gate is broken — **stop and report**; this is the security property the gate exists for.

- [ ] **Step 7: Commit**

```bash
git add src/workflows/project-harness-workflow.ts src/lib/project-harness-tools.ts \
        src/lib/project-harness-tools.test.ts .env.example
git commit -m "feat(projects): carry the approval gate onto the durable path

The destructive-tool predicate delegates to the shared tool-policy so the
durable path cannot drift from the fallback, and the approval secret is
passed by environment-variable name so the value never enters step
arguments, stream parts, or telemetry."
```

---

### Task 8: MCP discovery as its own step

**Why:** MCP tool names and schemas come from the server, so discovery needs I/O — which the workflow function cannot do (`fetch-in-workflow`). The previous draft's "rebuild MCP per tool step" is not executable as written (spec §3.8). Discovery is once per turn; the connection is rebuilt per execution.

**Files:**
- Create: `src/workflows/project-harness-mcp.ts`
- Modify: `src/workflows/project-harness-workflow.ts`

**Interfaces:**
- Consumes: `collectMcpTools()` (existing, in `src/lib/ai/mcp/manager`).
- Produces:

```ts
/** Serializable tool descriptors — no clients, no functions. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function discoverMcpToolsStep(): Promise<McpToolDescriptor[]>;
```

- [ ] **Step 1: Write the discovery step**

Create `src/workflows/project-harness-mcp.ts`:

```ts
import { collectMcpTools } from "@/lib/ai/mcp/manager";

/** Serializable tool descriptors. Plain data only — this crosses a boundary. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Discovers MCP tools once per turn.
 *
 * Discovery performs I/O (it asks each MCP server for its tool list), which
 * the workflow function cannot do — the runtime raises `fetch-in-workflow`.
 * So discovery is its own step, and the connection is rebuilt per execution
 * inside each tool step rather than being carried across the boundary.
 */
export async function discoverMcpToolsStep(): Promise<McpToolDescriptor[]> {
  "use step";
  const collected = await collectMcpTools();
  return Object.entries(collected.tools).map(([name, t]) => ({
    name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }));
}
```

- [ ] **Step 2: Rebuild tool definitions from the descriptors in the workflow**

In `projectHarnessWorkflow`, after building the canonical tools:

```ts
const mcpDescriptors = await discoverMcpToolsStep();
for (const descriptor of mcpDescriptors) {
  if (descriptor.name in tools) continue; // canonical names win
  tools[descriptor.name] = tool({
    description: descriptor.description,
    inputSchema: jsonSchema(descriptor.inputSchema as never),
    execute: makeMcpExecuteStep(descriptor.name),
  });
}
```

`makeMcpExecuteStep(name)` is a step-as-factory (valid for **tools**, per spec §3.4) whose inner function carries `"use step"`, reconnects to the named MCP server, and calls the tool — because the MCP client cannot cross the boundary.

- [ ] **Step 3: Verify discovery is once per turn**

Add an integration test that starts a run with two MCP-ish tools and asserts discovery ran exactly once (a counter in the step) while each tool call reconnected independently.

Run: `pnpm vitest run --config vitest.workflow.config.ts src/workflows/`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/project-harness-mcp.ts src/workflows/project-harness-workflow.ts
git commit -m "feat(projects): discover MCP tools in their own step

Discovery performs I/O, which the workflow function cannot do, so it runs
as a step once per turn; each tool execution rebuilds its connection
inside its own step because an MCP client cannot cross the boundary."
```

---

### Task 9: The workflow and its steps

**Why:** this is the architecture itself: a `"use workflow"` function that builds the agent and streams, plus the step functions that do real work.

**Files:**
- Create: `src/workflows/project-harness-workflow.ts`
- Create: `src/workflows/project-harness-steps.ts`
- Test: `src/lib/ai/__tests__/harness-loop.test.ts` (add the chat-boundary pin)
- Modify: `src/lib/project-harness-tools.ts` (tools' `execute` becomes `"use step"`, fed by serializable options)

**Interfaces:**
- Consumes: `DurableLanguageModel` (Task 2), `modelMessagesToUIMessages` (Task 5), `harnessStopReason` and `createHarnessStopConditions` (Stage 1), `createProjectHarnessTools` (existing).
- Produces:

```ts
export interface ProjectHarnessInput {
  projectId: string;
  sessionId: string;
  directoryPath: string;
  trusted: boolean;
  modelInit: DurableModelInit;
  messages: UIMessage[];
  budgetTokens: number;
}

export async function projectHarnessWorkflow(
  input: ProjectHarnessInput
): Promise<{ finishReason: string; stopReason: HarnessStopReason }>;
```

- [ ] **Step 1: Pin the chat boundary with a test first**

Add to `src/lib/ai/__tests__/harness-loop.test.ts` — this makes the "don't change chat" constraint enforceable rather than aspirational:

```ts
describe("chat loop policy is unchanged", () => {
  it("keeps the chat stop conditions separate from the harness ones", async () => {
    const { createChatStopConditions } = await import(
      "@/lib/ai/termination-conditions"
    );
    // The chat loop stops on a step cap AND on asking the user a question.
    // The harness has neither: it must not inherit the chat policy.
    expect(createChatStopConditions()).toHaveLength(2);
    expect(createHarnessStopConditions()).toHaveLength(1);
  });
});
```

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts -t "chat loop policy"`

Expected: PASS (both are already correct). This test is a guard, not a change.

- [ ] **Step 2: Make the project tools durable**

In `src/lib/project-harness-tools.ts`, each tool's `execute` must carry `"use step"` and receive its configuration as arguments rather than closing over it (spec §3.4: a step receives parameters, not closures). Concretely, for each tool in `createProjectHarnessTools`:

```ts
// BEFORE — the closure captures canonicalRoot/trusted/maxOutputChars:
execute: async ({ command }) => { /* uses canonicalRoot from the closure */ }

// AFTER — a named step function taking serializable arguments:
export async function projectBashStep(
  input: { command: string },
  options: { context?: { canonicalRoot: string; trusted: boolean } }
) {
  "use step";
  const { canonicalRoot, trusted } = options.context ?? { canonicalRoot: "", trusted: false };
  // …existing body, reading config from `context` instead of the closure…
}
```

Apply the same transformation to `file_operations` and the other mutating tools. `bash` and `file_operations` are **mutating**, so they must not retry (spec §3.6.4): set `projectBashStep.maxRetries = 0` and raise a `FatalError` when the underlying command fails, so a half-applied change is reported rather than silently retried.

The `toolsContext` map supplies `{ canonicalRoot, trusted }` per tool (Task 3 proved it arrives). `createProjectHarnessTools` keeps its signature so the fallback route still works — it now returns tools whose `execute` references the exported step functions.

- [ ] **Step 3: Write the workflow**

Create `src/workflows/project-harness-workflow.ts`:

```ts
import { WorkflowAgent } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";
import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";
import { createProjectHarnessTools } from "@/lib/project-harness-tools";
import {
  HARNESS_MAX_STEPS,
  createHarnessPrepareStep,
  createHarnessStopConditions,
  harnessStopReason,
  type HarnessStopReason,
} from "@/lib/ai/harness-loop";

export interface ProjectHarnessInput {
  projectId: string;
  sessionId: string;
  directoryPath: string;
  trusted: boolean;
  modelInit: DurableModelInit;
  messages: UIMessage[];
  budgetTokens: number;
}

/**
 * One durable Projects turn.
 *
 * The workflow function itself does no I/O and no domain work: it builds the
 * agent and streams. `WorkflowAgent` creates the durable steps internally —
 * the model call in its own `doStreamStep`, and each tool whose `execute`
 * carries `"use step"` — so a crash mid-turn re-runs only the incomplete step,
 * not the whole turn.
 *
 * `stopWhen` is mandatory: the agent applies no default step limit and would
 * otherwise run until the model stops calling tools.
 */
export async function projectHarnessWorkflow(
  input: ProjectHarnessInput
): Promise<{ finishReason: string; stopReason: HarnessStopReason }> {
  "use workflow";

  const tools = createProjectHarnessTools({
    projectDirectory: input.directoryPath,
    canonicalRoot: input.directoryPath,
    trusted: input.trusted,
    timeoutMs: 240_000,
    maxOutputChars: () => 40_000,
  });

  const agent = new WorkflowAgent({
    model: new DurableLanguageModel(input.modelInit) as never,
    instructions: "",
    tools: tools as never,
    toolsContext: {
      bash: { canonicalRoot: input.directoryPath, trusted: input.trusted },
      file_operations: {
        canonicalRoot: input.directoryPath,
        trusted: input.trusted,
      },
    } as never,
    stopWhen: isStepCount(HARNESS_MAX_STEPS),
    prepareStep: createHarnessPrepareStep({
      contextBudgetTokens: input.budgetTokens,
    }) as never,
  });

  const result = await agent.stream({
    messages: await convertToModelMessages(input.messages),
    writable: getWritable(),
  });

  const stopReason = harnessStopReason({
    steps: result.steps.length,
    finishReason: String(result.finishReason),
    contextWrapUp: false,
  });

  return { finishReason: String(result.finishReason), stopReason };
}
```

Notes for the implementer:
- `createHarnessStopConditions()` returns `[isStepCount(HARNESS_MAX_STEPS)]`; use `isStepCount` directly here because `WorkflowAgent` takes the condition, not the array.
- `instructions` is empty above because the system prompt is built from the project record; if `synthesizeProjectSystemPrompt(project)` must run, pass the **built prompt string** through `ProjectHarnessInput` (it is serializable) rather than calling the prompt engine inside the workflow — the workflow function has no Node.js access.
- `contextWrapUp: false` is a placeholder: context-guard attribution needs `prepareStep` telemetry, which must be wired from `prepareStep`'s `onContextGuard` callback. Until then a context wrap-up is reported as natural. Do not silently drop it — wire the callback in this task.

- [ ] **Step 4: Type-check and run the existing harness tests**

Run: `pnpm exec tsc --noEmit && pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts`

Expected: no type errors; the chat-boundary pin and all existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/project-harness-workflow.ts src/lib/project-harness-tools.ts \
        src/lib/ai/__tests__/harness-loop.test.ts
git commit -m "feat(projects): express the harness as a durable workflow

The workflow builds the agent and streams; WorkflowAgent supplies the
durable step boundaries. Project tools' execute now carries 'use step' and
reads its configuration from toolsContext instead of a closure, and the
mutating ones set maxRetries = 0 so a half-applied change is reported
rather than silently re-run."
```

---

### Task 10: Route behind a flag, claiming before `start()`

**Why:** the claim must happen in the **route, before `start()`** — by the time the workflow body runs the response has already begun streaming, so a claim there would surface as an in-stream error rather than an HTTP 409 (spec §4.5).

**Files:**
- Modify: `src/app/api/projects/chat/route.ts`

**Interfaces:**
- Consumes: `claimProjectRun` (Task 4), `projectHarnessWorkflow` (Task 9).
- Produces: a POST that either starts a durable run (header `x-workflow-run-id`, `x-harness-durable: 1`) or falls through to the existing `streamText` path.

- [ ] **Step 1: Add the flag branch at the top of the handler**

In `POST`, after the guard and body validation, before the existing model resolution:

```ts
const durable = process.env.PROJECT_HARNESS_DURABLE === "1";
```

- [ ] **Step 2: Claim, then start, then stream**

Insert the durable branch immediately after `canonicalRoot` is resolved and the in-flight check passes:

```ts
if (durable) {
  // Claim in the route, before start(): the response has already begun by the
  // time the workflow body runs, so a claim inside the workflow could only
  // surface as an in-stream error, not a 409 (spec §4.5).
  const { getRun } = await import("workflow/api");
  const claimed = claimProjectRun(
    sessionId,
    generateId(),
    (existingRunId) => {
      // Reconcile: a run that finished, failed, was cancelled, or was pruned
      // leaves a pointer the runtime no longer knows. A not-found result is
      // treated as stale so the session cannot lock permanently.
      try {
        const run = getRun(existingRunId);
        return run.status === "running" || run.status === "pending";
      } catch {
        return false;
      }
    }
  );
  if (!claimed) {
    return NextResponse.json(
      { error: "Session run is already in progress" },
      { status: 409 }
    );
  }

  const { start } = await import("workflow/api");
  const { projectHarnessWorkflow } = await import(
    "@/workflows/project-harness-workflow"
  );
  const { createModelCallToUIChunkTransform } = await import(
    "@ai-sdk/workflow"
  );

  const run = await start(projectHarnessWorkflow, [
    {
      projectId,
      sessionId,
      directoryPath: project.directoryPath,
      trusted: project.trusted,
      modelInit: {
        providerId: /* resolved provider id */,
        modelId: resolvedModelId,
        apiKeyEnv: /* resolved provider.apiKeyEnv */,
      },
      messages: rawMessages,
      budgetTokens,
    },
  ]);

  return createUIMessageStreamResponse({
    stream: run.readable.pipeThrough(createModelCallToUIChunkTransform()),
    headers: {
      "x-workflow-run-id": run.runId,
      "x-harness-durable": "1",
      "x-reasoning-effort": resolvedEffort,
      "x-context-budget": String(budgetTokens),
    },
  });
}
```

The `providerId` and `apiKeyEnv` values come from the same `provider` object the existing model-resolution block already reads; capture them there instead of re-loading the registry.

**The claim's runId must be the real one.** The snippet above claims with a placeholder `generateId()` before `start()` exists. Fix this properly: `start()` returns the run id, so either (a) claim with a sentinel and update the row to the real id immediately after `start()` returns, inside the same request, or (b) call `start()` first and accept a tiny window. Choose (a) and make the sentinel-to-real update part of the same function — a claimed pointer that never matches the real run would be reclaimed as stale on the next request, defeating the lock. Write the update explicitly:

```ts
// After start() resolves, replace the sentinel with the real run id so the
// pointer matches what getRun() will be asked about.
replaceProjectRunId(sessionId, sentinelId, run.runId);
```

Add `replaceProjectRunId(sessionId, fromRunId, toRunId)` to `project-service.ts` in this task, with a test mirroring the release guard (it must affect 0 rows if the pointer changed meanwhile).

- [ ] **Step 3: Verify the flag off-path is untouched**

Run: `pnpm exec tsc --noEmit`

Expected: no errors.

Then run the app with `PROJECT_HARNESS_DURABLE` unset and confirm a Projects message still streams via the old path (the fallback must keep working during the transition — spec §7.2).

- [ ] **Step 4: Verify the 409**

With `PROJECT_HARNESS_DURABLE=1`, send two POSTs for the same session in quick succession. Expected: the first starts a run; the second returns **409** with `Session run is already in progress`, **before** any stream is created.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/chat/route.ts src/lib/project-service.ts src/lib/__tests__/project-service.test.ts
git commit -m "feat(projects): start the durable harness behind PROJECT_HARNESS_DURABLE

The run is claimed in the route before start(), so a concurrent request
gets an HTTP 409 rather than an in-stream error. The sentinel id is
replaced with the real run id immediately after start() returns, so the
pointer matches what getRun() is later asked about."
```

---

### Task 11: Reconnection endpoint and transcript persistence

**Why:** two gaps remain. The client must be able to reconnect mid-run (raw replay from index 0 with a UI cursor — **not** `getReadable({ startIndex })`, which is wrong for this stream type), and the transcript must be saved by a step so it no longer depends on a client being connected (spec §4.4a/§4.4b).

**Files:**
- Create: `src/app/api/projects/chat/[runId]/stream/route.ts`
- Modify: `src/workflows/project-harness-workflow.ts` (finalisation step)
- Modify: `src/workflows/project-harness-steps.ts`

**Interfaces:**
- Consumes: `modelMessagesToUIMessages` (Task 5), `releaseProjectRun` (Task 4), `saveProjectSession` (existing).
- Produces: a GET endpoint returning the durable stream; a finalisation step that persists.

- [ ] **Step 1: Write the reconnect route**

Create `src/app/api/projects/chat/[runId]/stream/route.ts`:

```ts
import { createUIMessageStreamResponse } from "ai";
import { createModelCallToUIChunkTransform } from "@ai-sdk/workflow";
import { getRun } from "workflow/api";
import type { NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const { runId } = await params;
  const startIndex = Number(
    new URL(request.url).searchParams.get("startIndex") ?? "0"
  );
  if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
    return Response.json(
      { error: "startIndex must be a non-negative safe integer" },
      { status: 400 }
    );
  }

  const run = await getRun(runId);
  // Replay the raw ModelCallStreamPart stream from index 0 and apply the UI
  // cursor in the transform. Passing startIndex straight to getReadable would
  // duplicate or drop chunks: the transport counts UIMessageChunks while the
  // durable stream stores raw parts. Negative indexes are not usable here.
  const readable = run
    .getReadable({ startIndex: 0 })
    .pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex: startIndex }));

  return createUIMessageStreamResponse({
    stream: readable,
    headers: { "x-workflow-run-id": runId },
  });
}
```

- [ ] **Step 2: Add the finalisation step**

In `src/workflows/project-harness-steps.ts`:

```ts
import { modelMessagesToUIMessages } from "@/lib/ai/model-message-to-ui-message";
import { getProjectSession, saveProjectSession, releaseProjectRun } from "@/lib/project-service";
import type { ModelMessage } from "ai";

/**
 * Persists the finished turn and releases the run slot.
 *
 * Runs *after* `agent.stream()` resolves, so it does not depend on a client
 * being connected — which is the whole point: a browser that died mid-run
 * must still get its transcript saved. Reading the run's own stream back is
 * not an option: the stream closes only when the run completes, and the run is
 * waiting on this step (measured in the gate 5 spike).
 */
export async function finalizeProjectHarnessRun(input: {
  sessionId: string;
  runId: string;
  messages: ModelMessage[];
}) {
  "use step";

  const session = await getProjectSession(input.sessionId);
  if (!session) {
    // The session was deleted mid-run; nothing to persist, but the slot must
    // still be released so a later session with the same id is not locked.
    releaseProjectRun(input.sessionId, input.runId);
    return { persisted: false };
  }

  const uiMessages = modelMessagesToUIMessages(input.messages, {
    generateId: () => `pmsg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  });

  await saveProjectSession({
    ...session,
    messages: uiMessages,
    updatedAt: Date.now(),
  });
  releaseProjectRun(input.sessionId, input.runId);

  return { persisted: true };
}
```

- [ ] **Step 3: Call it from the workflow**

At the end of `projectHarnessWorkflow`, before returning:

```ts
await finalizeProjectHarnessRun({
  sessionId: input.sessionId,
  runId: input.runId,
  messages: result.messages,
});
```

Add `runId: string` to `ProjectHarnessInput` and pass it from the route (the real id from `start()`; if the sentinel approach from Task 10 is used, pass the real one here).

- [ ] **Step 4: Verify persistence with no client attached**

Run: `pnpm vitest run --config vitest.workflow.config.ts src/workflows/`

Expected: PASS. Then manually: start a run with `PROJECT_HARNESS_DURABLE=1`, close the browser tab immediately, wait for the run to finish, and confirm the transcript is present in `project_messages` (this is spec acceptance criterion 7).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/projects/chat/[runId]/stream/route.ts" \
        src/workflows/project-harness-workflow.ts src/workflows/project-harness-steps.ts
git commit -m "feat(projects): reconnect endpoint and client-independent persistence

The GET endpoint replays the raw ModelCallStreamPart stream from index 0
and applies the UI cursor in the transform, because the transport counts
UIMessageChunks while the durable stream stores raw parts. Persistence
moves into a finalisation step that runs after stream() resolves, so a
transcript is saved even when no client is attached."
```

---

### Task 12: Client transport

**Why:** the client must use `WorkflowChatTransport` on the durable path and the existing transport otherwise, and it must not guess — the server tells it (spec §7.2).

**Files:**
- Modify: `src/components/projects/ProjectWorkspace.tsx`

**Interfaces:**
- Consumes: the `x-harness-durable` response header from Task 10.
- Produces: a `useChat` configured with the right transport.

- [ ] **Step 1: Read the current transport setup**

Run: `grep -n "useChat\|resume\|transport" src/components/projects/ProjectWorkspace.tsx | head -20`

Note the existing `useChat({ resume: true, id: activeSessionId })` call and what transport (if any) it passes.

- [ ] **Step 2: Add the durable transport**

```tsx
import { WorkflowChatTransport } from "@ai-sdk/workflow";

// The server decides: it returns x-harness-durable on the POST. The client
// must not guess, so the transport is created only when that header was seen
// for this session.
const transport = useMemo(
  () =>
    durableRunId
      ? new WorkflowChatTransport({
          api: "/api/projects/chat",
          onChatEnd: () => setDurableRunId(undefined),
        })
      : undefined,
  [durableRunId]
);

const { messages, sendMessage, status } = useChat({
  id: activeSessionId,
  resume: Boolean(durableRunId),
  ...(transport ? { transport } : {}),
});
```

`durableRunId` is state set from the POST response header. If the existing code path does not expose the response, use the transport's `onChatSendMessage` callback (as the AI SDK docs show) to read `x-workflow-run-id` and `x-harness-durable`, and persist the run id per session so a reload can resume.

- [ ] **Step 3: Verify both paths**

Run: `pnpm exec tsc --noEmit`

Expected: no errors.

Manually, with `PROJECT_HARNESS_DURABLE=1`: send a message, refresh the page mid-run, and confirm the stream reconnects with **no duplicated output** (spec acceptance criterion 3). Then unset the flag and confirm the old path still works.

- [ ] **Step 4: Commit**

```bash
git add src/components/projects/ProjectWorkspace.tsx
git commit -m "feat(projects): use WorkflowChatTransport on the durable path

The server signals the durable path with x-harness-durable, so the client
does not guess. Reconnecting resumes the durable stream instead of
replaying the in-process registry."
```

---

## Phase D — Operations

### Task 13: Version dedupe and retention

**Why:** two copies of `ai` are in the tree (the app resolves `7.0.77`, `@ai-sdk/workflow` resolves `7.0.97`), which is why `durable-agents.ts` carries a type cast. The spec (§7.3) requires deduping rather than casting. Separately, completed runs accumulate in `data/workflow` with no stated policy (§4.6).

**Files:**
- Modify: `package.json`
- Modify: `src/lib/ai/durable-agents.ts` (remove the now-unnecessary cast)
- Create: `src/lib/workflow-retention.ts`
- Test: `src/lib/__tests__/workflow-retention.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except the dedupe precondition.
- Produces: one `ai` copy; a documented retention policy.

- [ ] **Step 1: Dedupe `ai`**

```bash
pnpm add ai@^7.0.97
pnpm install
```

Then verify:

```bash
ls -d node_modules/.pnpm/ai@* ; node -e "console.log(require('./node_modules/ai/package.json').version)"
```

Expected: a single `ai@7.0.97` (or newer 7.0.x), and `@ai-sdk/workflow` resolving to the same copy.

- [ ] **Step 2: Remove the cast that existed only for the skew**

In `src/lib/ai/durable-agents.ts`, the `durableTool` helper documents that `ToolSet` is structurally incompatible across the two `ai` versions. With one copy, that workaround should be removable. Read the file, delete the now-stale comment block, and simplify the signature. If the cast is still required, **stop and report** — it means the dedupe did not take effect.

Run: `pnpm exec tsc --noEmit`

Expected: no errors after the simplification.

- [ ] **Step 3: Write the retention test**

Create `src/lib/__tests__/workflow-retention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { runsToPrune, WORKFLOW_RETENTION_DAYS } from "@/lib/workflow-retention";

const now = new Date("2026-09-21T00:00:00Z");
const daysAgo = (n: number) =>
  new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("runsToPrune", () => {
  it("keeps runs inside the retention window", () => {
    const runs = [{ runId: "a", createdAt: daysAgo(1) }];
    expect(runsToPrune(runs, now)).toEqual([]);
  });

  it("prunes runs older than the window", () => {
    const runs = [{ runId: "b", createdAt: daysAgo(WORKFLOW_RETENTION_DAYS + 1) }];
    expect(runsToPrune(runs, now)).toEqual(["b"]);
  });

  it("keeps a run exactly at the boundary", () => {
    const runs = [{ runId: "c", createdAt: daysAgo(WORKFLOW_RETENTION_DAYS) }];
    expect(runsToPrune(runs, now)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/__tests__/workflow-retention.test.ts`

Expected: FAIL — cannot resolve the module.

- [ ] **Step 5: Implement it**

Create `src/lib/workflow-retention.ts`:

```ts
/** Completed workflow runs older than this are pruned from data/workflow. */
export const WORKFLOW_RETENTION_DAYS = 30;

export interface WorkflowRunRecord {
  runId: string;
  createdAt: string;
}

/**
 * Selects runs eligible for pruning.
 *
 * Pure so the policy is testable without touching the filesystem. A run is
 * pruned only once it is strictly older than the window: a boundary run is
 * kept, because pruning it early loses data a user might still resume from.
 *
 * Note for the caller: pruning a run whose id is still recorded in
 * `project_sessions.active_run_id` is safe *because* the claim path treats a
 * not-found run as stale (spec §4.5). Do not change one without the other.
 */
export function runsToPrune(
  runs: WorkflowRunRecord[],
  now: Date
): string[] {
  const cutoff = now.getTime() - WORKFLOW_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return runs
    .filter((run) => new Date(run.createdAt).getTime() < cutoff)
    .map((run) => run.runId);
}
```

- [ ] **Step 6: Run the tests and type-check**

Run: `pnpm vitest run --project unit src/lib/__tests__/workflow-retention.test.ts && pnpm exec tsc --noEmit`

Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/ai/durable-agents.ts \
        src/lib/workflow-retention.ts src/lib/__tests__/workflow-retention.test.ts
git commit -m "chore(workflow): dedupe ai to one copy and add a retention policy

Two copies of ai (7.0.77 for the app, 7.0.97 for @ai-sdk/workflow) forced
a structural cast in durable-agents.ts. Deduping removes it. Adds a pure
30-day retention selector for data/workflow, documented as coupled to the
not-found-is-stale claim rule."
```

---

### Task 14: Session deletion must not orphan a run

**Why:** deleting a session while a run holds `activeRunId` would leave a run writing to a removed session (spec §4.6).

**Files:**
- Modify: `src/lib/project-service.ts` (`deleteProjectSession`, ~line 807)
- Test: `src/lib/__tests__/project-service.test.ts`

**Interfaces:**
- Consumes: `releaseProjectRun` (Task 4).
- Produces: a delete path that cancels first.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/project-service.test.ts`:

```ts
describe("deleteProjectSession with an active run", () => {
  it("cancels the run before deleting the session", async () => {
    const cancelled: string[] = [];
    await deleteProjectSession(sessionId, {
      cancelRun: async (runId: string) => {
        cancelled.push(runId);
      },
    });
    expect(cancelled).toEqual(["wrun_current"]);
    expect(await getProjectSession(sessionId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/__tests__/project-service.test.ts -t "cancels the run"`

Expected: FAIL — `deleteProjectSession` takes no options argument.

- [ ] **Step 3: Implement the cancel-then-delete**

Change the signature to accept an injected canceller (so the service keeps no Workflow dependency) and call it before the delete:

```ts
export async function deleteProjectSession(
  sessionId: string,
  options: { cancelRun?: (runId: string) => Promise<void> } = {},
  db: AppDatabase = defaultDb
): Promise<void> {
  const session = await getProjectSession(sessionId, db);

  // Cancel an in-flight durable run before removing its session: the run
  // writes to this session on completion, so deleting first would orphan it.
  // Cancellation is awaited because the run must stop before the row goes.
  if (session?.activeRunId && options.cancelRun) {
    await options.cancelRun(session.activeRunId);
  }

  db.delete(projectSessions).where(eq(projectSessions.id, sessionId)).run();
}
```

The route or caller wires `cancelRun: async (runId) => { await getRun(runId).cancel(); }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit src/lib/__tests__/project-service.test.ts`

Expected: PASS — new test plus all existing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-service.ts src/lib/__tests__/project-service.test.ts
git commit -m "fix(projects): cancel a live run before deleting its session

Deleting first would orphan a run that writes to the session on
completion. The canceller is injected so project-service keeps no
dependency on the Workflow runtime."
```

---

## Self-Review

**Spec coverage:**
- §3.1 two layers → Task 9 ✔
- §3.2 engine + mandatory `stopWhen` → Task 9 ✔
- §3.3 signed approval preserved → Task 7 (gate 1: `needsApproval` delegating to the shared policy, secret by env-var name, tamper test) ✔
- §3.4 serialization boundary + `toolsContext` → Tasks 3, 9 ✔
- §3.4.0 model across the boundary → Task 2 ✔
- §3.5 Next/Workflow wiring + import pinning → Task 1 (imports pinned in Tasks 10–12) ✔
- §3.6 retry/replay/tool side effects → Task 9 (mutating tools `maxRetries = 0` + `FatalError`) ✔
- §3.7 timeout/watchdog on the durable path → Task 6 (gate 5: watchdog on the model class, or a written accepted loss) ✔
- §3.8 MCP discovery as a step → Task 8 ✔
- §4.2 `active_run_id` → Task 4 ✔
- §4.3 task list → **deliberately dropped.** `task_list_manager` is stateless and the UI renders it from the transcript, so persisting the transcript (Task 11) preserves it. No `project_tasks` table, no migration. The spec's §4.3 premise is wrong and is amended in Task 11's commit.
- §4.4a reconnection → Task 11 ✔
- §4.4b converter + finalisation → Tasks 5, 11 ✔
- §4.5 claim in the route + stale reconciliation → Tasks 4, 10 ✔
- §4.6 isolation, retention, deletion → Tasks 1, 13, 14 ✔
- §5.1–5.4 flow, resume, error handling → Tasks 9–11 ✔
- §5.5 chunk watchdog (single-request path) → Stage 1 ✔
- §6 tests → every task carries its own; §6.1 criteria 3–7 covered by Tasks 10–12, 14 ✔
- §7.2 flag + exit criteria → Task 10 (flag); exit criteria are operational, not code ✔
- §7.3 version dedupe → Task 13 ✔
- §7.4 gates 1–9 → gate 1 (Task 7), gate 2 (Task 13), gate 5 (Task 6), gates 8–9 (Tasks 2–3). Gates 3, 4, 6, 7 are verification activities inside Tasks 3, 9, 11 — each names the assertion it must produce.

**Placeholder scan:** no TBD/TODO. Two intentional, labelled stubs remain in Task 9 — `instructions: ""` (the system prompt must be passed in as a serializable string, since the workflow function has no Node access) and the context-wrap-up flag — and both name exactly what must replace them. Task 10's sentinel handling names the exact function to add. Nothing is silently omitted.

**Type consistency:** `DurableModelInit` is defined in Task 2 and used identically in Tasks 3, 9, 10. `HarnessStopReason` comes from Stage 1 and is used in Task 9. `claimProjectRun`/`releaseProjectRun` signatures match between Task 4 and Tasks 9, 10, 11, 14. `replaceProjectRunId` is introduced and consumed inside Task 10. `ProjectHarnessInput` gains `runId` in Task 11 — stated there, not assumed. `McpToolDescriptor` is defined and consumed inside Task 8.

**Dependency order:** Phase A (1–3) must run in order — Task 3 cannot pass without Task 2's model, and Task 2 cannot run without Task 1's Workflow runtime. Phase B (4–5) is independent of Phase A and can proceed in parallel. Task 6 (watchdog) depends on Task 2. Task 7 (approval) and Task 8 (MCP) depend on Task 3. Task 9 (the workflow) depends on Tasks 2–8. Phase D (13–14) is independent.

**Known open item carried from the spec, not a plan gap:** gate 9's runtime verdict (Task 3) is unobserved as of writing. The plan is executable because Task 3 either passes — unblocking Task 9 — or stops and reports, which is the correct behaviour given the spec states there is no accepted-loss fallback for it.

**Conclusion:** the plan is executable end to end, in the order Phase A → B → C → D. The only branch point is Task 3, whose failure is designed to halt rather than improvise. Stage 1 must land and be observed first.
