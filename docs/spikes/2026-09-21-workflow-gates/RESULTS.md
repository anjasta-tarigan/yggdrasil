# Spike results — Stage 2 gates 5 and 9

**Date:** 2026-09-21
**Method:** isolated spike project (`spike/`) in a throwaway git worktree, using
`@workflow/vitest@5.0.0-beta.50` + `workflow@5.0.0-beta.50` + `@ai-sdk/workflow@2.0.28` + `ai@7.0.97`,
running real workflow transforms and an in-process Local World. No production code touched.

---

## Gate 5 — can a step drain its own run's stream?

**Spec claim tested (§4.4(b)):** "a durable stream stays open until the run completes, so
iterating it to completion from inside the run deadlocks."

**Result: the claim is CONFIRMED, with an important nuance.**

```
GATE5 READBACK: {"outcome":"timeout","timedOut":true,"chunkCount":2,"chunks":["alpha","beta"]}
```

- The step **can read chunks already written** by its own run (`chunkCount: 2`, both payloads intact).
- It **cannot reach `done`**: `reader.read()` never resolves after the last available chunk, because the
  stream is only closed when the run completes — and the run is waiting on this step. Measured timeout: 3 s budget, hit.
- So *"drain the stream to completion from inside the run"* deadlocks exactly as §4.4(b) says.

**Consequence for the spec:** the `getRun(runId).getReadable()` **read-back alternative remains rejected**
for the "await the whole stream" form. However, the nuance opens a cheaper variant worth noting:
a finalisation step *could* read the chunks **already present** (no `done` wait) and stop at the current tail.
That is racy and unbounded in general, but it is not the blanket deadlock the spec implies — the spec's
wording should be tightened to "awaiting the stream's end from inside the run deadlocks", not "reading it".

**Verdict:** converter decision stands; §4.4(b) verification note can be resolved with the narrower wording.

---

## Gate 9 — tool `execute` shape, and what must cross the step boundary

**Spec claim tested (§3.4):** tools need `'use step'` (top-level or step-as-factory), fed by `toolsContext`.

**Result: the claim is CONFIRMED, and the spike exposed a larger, unlisted serialization constraint.**

### 9.1 A tool whose `execute` lacks `'use step'` runs in workflow context — proven by the compiler

Using `node:fs` inside such an `execute` produced a **build error**, not a runtime one:

```
ERROR: [plugin: workflow-node-module-error] You are attempting to use "node:fs" which is a Node.js module.
Node.js modules are not available in workflow functions.
suggestion: 'Move this function into a step function.'
```

This is direct evidence for §3.6.3: without `'use step'`, `execute` sits in the workflow sandbox.
The directive is required, not optional.

### 9.2 Serialization failures are at `.args[1]` — the MODEL, not the tool

Every tool shape (top-level step, step-as-factory, `durableTool` HOF) failed **identically** at
`Failed to serialize step arguments at path ".args[1]"`, and with a plain-object model at
`".args[1].doStream"`.

Tracing `doStreamStep(conversationPrompt, modelInit, writable, serializedTools, options)` shows
**argument 2 is the model**. So the failures had nothing to do with tool shape — they were the
**model failing to serialize**.

### 9.3 The decisive finding: provider instances do NOT cross the step boundary; model strings DO

| Model passed | Result |
|---|---|
| `MockLanguageModelV4` (class instance) | `SerializationError` at `.args[1]` |
| Plain object with `doStream` method | `SerializationError` at `.args[1].doStream` (functions are not serializable) |
| Step-as-factory returning the model | serialization passes, `doStreamStep` entered |
| **String model id (`"openai/gpt-4o-mini"`)** | **serialization passes, `doStreamStep` entered**, fails only on AI Gateway auth |

The string case is conclusive: the step ran and reached the gateway, i.e. the model crossed the boundary
cleanly. `doStreamStep` resolves it via `gateway.languageModel(modelInit)`.

**This is a finding the spec does not cover.** §3.4 lists what must be serializable for *tools*; it never
states that the **model** is also a step argument. Projects builds its model from a provider registry
(`chatModelForEntry(...)` → a provider instance), which is exactly the shape that fails.

**Consequence for the spec:** the workflow must pass either a **model string** (gateway-style) or a
**step-as-factory returning the model**, never a provider instance. Since yggdrasil uses its own provider
registry (not Vercel AI Gateway), the applicable option is the **step-as-factory**, with serializable
constructor arguments (provider id, model id, resolved key reference) rebuilt inside the step.
This belongs in §3.4 as a new row and in the Stage 2 gate list.

---

## Tooling notes (for the implementation plan)

1. `@workflow/vitest` must match the `workflow` major: `@workflow/vitest@4.0.25` (which bundles
   `@workflow/core@4.8.9`) **fails** against `workflow@5.0.0-beta.50` — it transforms the runtime's own
   files and errors with `Functions marked with "use step" must be async functions`. Use
   **`@workflow/vitest@5.0.0-beta.50`**.
2. Workflows must live in a **separate module** from the test file; defining `"use workflow"` inside a
   test callback breaks the builder (`Calling the suite function inside test function is not allowed`).
3. A workflow test project needs its own Vitest config with the `workflow()` plugin.

## What the spikes did NOT settle

- Whether `toolsContext` entries reach `execute` as `context` at runtime — blocked because the mock model
  could not complete a turn (spec-version skew inside the step bundle). The SDK source
  (`resolveToolContext` → `execute(input, { context })`) is unambiguous, but it is **unverified at runtime**.
- The chunk watchdog middleware (gate 5's other half, §3.7) — not attempted here; it is about the model
  wrapper, and 9.3 shows a wrapped model must itself be rebuilt in a step.
