# Project Harness Stage 1 — Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Projects task run to completion with an always-visible stop reason, before any durable-execution work begins.

**Architecture:** Two independent changes to the existing `streamText` harness, no new modules and no new dependencies. (A) Reinstate the per-gap chunk watchdog at a value far above any reasoning pause, so a dead provider socket is still detected without killing thinking models. (B) Extract a pure `harnessStopReason()` helper and attach its result to the assistant message metadata, so the client can tell a natural stop from a step-cap, a context wrap-up, or a timeout.

**Tech Stack:** TypeScript (strict), AI SDK v7 (`ai@7.0.77` direct), Vitest 4, pnpm, Drizzle/SQLite (untouched here).

**Spec:** `docs/superpowers/specs/2026-09-21-project-coding-harness-design.md` §1.1, §5.3, §5.5, §7.1.

## Global Constraints

- Branch: `development` — work directly, no new branches (the spec's Stage 1 ships on the current branch).
- **Uncommitted work already exists in the tree.** `git status` shows `src/lib/ai/harness-loop.ts`, `src/lib/ai/__tests__/harness-loop.test.ts`, and `src/app/api/projects/chat/route.ts` modified: the `chunkMs` removal, raised timeouts, `timeoutAbortToErrorPart()`, `onAbort` logging, and their tests. **Do not revert it** — Task 1 builds on it and Task 3 commits it.
- No new dependencies.
- No `any`. No empty `catch` (log or rethrow).
- Do NOT touch `src/app/api/chat/route.ts`, `src/lib/ai/prepare-step.ts`, `src/lib/ai/termination-conditions.ts`, `src/lib/ai/context-budget.ts`.
- Every AI SDK v7 symbol verified against installed `node_modules/ai`, not memory.
- Tests run under the `unit` Vitest project (`pnpm vitest run --project unit <file>`), never a full parallel suite (Rule 18).
- `pnpm exec tsc --noEmit` and the unit project must stay green.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/lib/ai/harness-loop.ts` | `HARNESS_TIMEOUT` (add `chunkMs`), new pure `harnessStopReason()` |
| Modify | `src/lib/ai/__tests__/harness-loop.test.ts` | Flip the `chunkMs` guard; add `harnessStopReason` tests |
| Modify | `src/app/api/projects/chat/route.ts` | Attach stop-reason metadata to the assistant message |

No files are created. The whole stage is two edits plus tests.

---

### Task 1: Reinstate the chunk watchdog at 5 minutes

**Why:** the uncommitted fix removed `chunkMs` entirely. That stopped reasoning models being killed mid-think, but it also removed dead-socket detection: a wedged provider now burns the full `stepMs` (10 min). The spec (§5.5) reinstates the watchdog at a value far above any plausible gap between output chunks — reasoning deltas reset it, so 5 minutes of silence means the socket is dead.

**Files:**
- Modify: `src/lib/ai/harness-loop.ts:47-72` (the `HARNESS_TIMEOUT` const and its doc comment)
- Test: `src/lib/ai/__tests__/harness-loop.test.ts` (the `HARNESS_TIMEOUT policy` describe block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `HARNESS_TIMEOUT.chunkMs: number` — read by the route's `timeout:` option (already passed through as the whole object) and asserted by the tests below. No other task in this plan reads it directly.

- [ ] **Step 1: Read the current state of both files**

Run: `git diff src/lib/ai/harness-loop.ts src/lib/ai/__tests__/harness-loop.test.ts`

Confirm the tree already has `chunkMs` **removed** from `HARNESS_TIMEOUT` and a test asserting `expect("chunkMs" in HARNESS_TIMEOUT).toBe(false)`. Do not revert that work; the next steps amend it.

- [ ] **Step 2: Write the failing test (flip the guard)**

In `src/lib/ai/__tests__/harness-loop.test.ts`, inside the `HARNESS_TIMEOUT policy` describe block, replace the existing chunk-watchdog assertion:

```ts
// BEFORE (from the uncommitted fix — this locked in an overcorrection):
it("has no per-chunk watchdog (a reasoning model emits no output while thinking)", () => {
  expect("chunkMs" in HARNESS_TIMEOUT).toBe(false);
});

// AFTER: the watchdog exists, but far above any reasoning pause, and strictly
// below stepMs so it can actually fire first.
it("keeps a chunk watchdog below stepMs and at least 5 minutes", () => {
  expect("chunkMs" in HARNESS_TIMEOUT).toBe(true);
  expect(HARNESS_TIMEOUT.chunkMs).toBeGreaterThanOrEqual(5 * 60_000);
  expect(HARNESS_TIMEOUT.chunkMs).toBeLessThan(HARNESS_TIMEOUT.stepMs);
});
```

Also extend the existing ordering assertion in the same block to include `chunkMs`:

```ts
it("keeps total > step > chunk > firstChunk ordering", () => {
  expect(HARNESS_TIMEOUT.totalMs).toBeGreaterThan(HARNESS_TIMEOUT.stepMs);
  expect(HARNESS_TIMEOUT.stepMs).toBeGreaterThan(HARNESS_TIMEOUT.chunkMs);
  expect(HARNESS_TIMEOUT.chunkMs).toBeGreaterThan(HARNESS_TIMEOUT.firstChunkMs);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts -t "chunk watchdog"`

Expected: FAIL — `expected false to be true` (the property does not exist yet), and the ordering test fails on `chunkMs` being `undefined`.

- [ ] **Step 4: Add `chunkMs` back to the constant**

In `src/lib/ai/harness-loop.ts`, change `HARNESS_TIMEOUT` to:

```ts
export const HARNESS_TIMEOUT = {
  totalMs: 60 * 60_000,
  stepMs: 10 * 60_000,
  // Gap between consecutive output chunks. A reasoning model emits no output
  // while thinking, so this must sit far above any plausible thinking pause —
  // but strictly below stepMs, or the watchdog can never fire first and a dead
  // socket burns the whole step. Reasoning deltas reset it; five minutes of
  // silence means the connection is dead.
  chunkMs: 5 * 60_000,
  firstChunkMs: 3 * 60_000,
  toolMs: 2 * 60_000,
  tools: { bashMs: 5 * 60_000 },
} as const;
```

Update the doc comment above the constant: delete the paragraph that begins "There is deliberately NO `chunkMs` watchdog", and replace it with:

```
 * The `chunkMs` watchdog is a *per-gap* timeout, not a cumulative one: the SDK
 * re-arms it on every output chunk (see `resetChunkTimeout` in
 * node_modules/ai/dist/index.js), so it only fires when the stream genuinely
 * stalls. It is deliberately set well above any reasoning pause and below
 * `stepMs`; an earlier value of 60s killed reasoning runs after ~6 steps with
 * no error, because the SDK reports a timeout as an *abort*, which does not
 * fire `onError`.
 *
 * Invariants (asserted in harness-loop.test.ts):
 *   totalMs > stepMs > chunkMs > firstChunkMs
 *   tools.bashMs > HARNESS_BASH_TIMEOUT_MS > 60_000
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts`

Expected: PASS — all tests in the file, including the flipped guard and the extended ordering test.

- [ ] **Step 6: Type-check**

Run: `pnpm exec tsc --noEmit`

Expected: no errors. (`chunkMs` is part of the object already passed as `timeout:` to `streamText`, so no route change is needed.)

- [ ] **Step 7: Do NOT commit yet**

Task 3 commits this together with the pre-existing uncommitted work, so the timeout fix lands as one coherent commit rather than a half-state.

---

### Task 2: Make the stop reason observable to the client

**Why:** the run-end log (`formatHarnessRunEndLog`) already distinguishes a natural stop from a step cap and a context wrap-up — but only server-side. The client sees `finishReason: "stop"` in every one of those cases and cannot tell them apart, which is what made the original bug look like a silent success. This task adds a pure helper and attaches its result to the assistant message metadata.

**Files:**
- Modify: `src/lib/ai/harness-loop.ts` (add `harnessStopReason`, next to `formatHarnessRunEndLog` at ~line 95)
- Test: `src/lib/ai/__tests__/harness-loop.test.ts` (new describe block)
- Modify: `src/app/api/projects/chat/route.ts` (track the last step number; extend `messageMetadata`)

**Interfaces:**
- Consumes: `HARNESS_MAX_STEPS` (existing export in the same file).
- Produces: `harnessStopReason(input: HarnessStopReasonInput): HarnessStopReason`, where

```ts
export type HarnessStopReason = "natural" | "step-cap" | "context-wrap-up";

export interface HarnessStopReasonInput {
  steps: number;
  finishReason: string;
  contextWrapUp: boolean;
}
```

Rule: `context-wrap-up` wins over `step-cap` only when `contextWrapUp` is true; otherwise `steps >= HARNESS_MAX_STEPS` is `step-cap`; otherwise `natural`. (A timeout never reaches this helper — the route converts it to an `error` part via `timeoutAbortToErrorPart`, so it surfaces as an error, not a stop reason.)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/ai/__tests__/harness-loop.test.ts`:

```ts
describe("harnessStopReason", () => {
  it("reports a natural stop when the model finished on its own", () => {
    expect(
      harnessStopReason({ steps: 7, finishReason: "stop", contextWrapUp: false })
    ).toBe("natural");
  });

  it("reports a step cap when the run reached HARNESS_MAX_STEPS", () => {
    expect(
      harnessStopReason({
        steps: HARNESS_MAX_STEPS,
        finishReason: "stop",
        contextWrapUp: false,
      })
    ).toBe("step-cap");
  });

  it("reports a context wrap-up ahead of a step cap", () => {
    expect(
      harnessStopReason({
        steps: HARNESS_MAX_STEPS,
        finishReason: "stop",
        contextWrapUp: true,
      })
    ).toBe("context-wrap-up");
  });

  it("reports a context wrap-up below the step cap", () => {
    expect(
      harnessStopReason({ steps: 12, finishReason: "stop", contextWrapUp: true })
    ).toBe("context-wrap-up");
  });
});
```

Add `harnessStopReason` and `HARNESS_MAX_STEPS` to the existing import from `@/lib/ai/harness-loop` at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts -t "harnessStopReason"`

Expected: FAIL — `harnessStopReason is not a function` (or an import error).

- [ ] **Step 3: Implement the helper**

In `src/lib/ai/harness-loop.ts`, directly after `formatHarnessRunEndLog`:

```ts
/** Why a harness turn ended, in the terms the client can act on. */
export type HarnessStopReason = "natural" | "step-cap" | "context-wrap-up";

/** Inputs for {@link harnessStopReason}. */
export interface HarnessStopReasonInput {
  steps: number;
  finishReason: string;
  contextWrapUp: boolean;
}

/**
 * Classifies a completed turn for the client.
 *
 * `contextWrapUp` is checked before the step cap because a context wrap-up that
 * happens to land on the final permitted step is still a context wrap-up: the
 * user needs to know the prompt ran out of room, not that the budget did.
 * A timeout is deliberately absent — the route turns it into an `error` part
 * (`timeoutAbortToErrorPart`), so it is not a stop reason.
 */
export function harnessStopReason(
  input: HarnessStopReasonInput
): HarnessStopReason {
  if (input.contextWrapUp) return "context-wrap-up";
  if (input.steps >= HARNESS_MAX_STEPS) return "step-cap";
  return "natural";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts -t "harnessStopReason"`

Expected: PASS — four tests.

- [ ] **Step 5: Track the last step number in the route**

In `src/app/api/projects/chat/route.ts`, near the other accumulators (the block that declares `let contextElisions = 0;` and `let contextWrapUp = false;`), add:

```ts
// Last step index seen, so the finish metadata can classify the stop.
// `onStepEnd` receives `stepNumber` (0-indexed); the count of steps taken is
// therefore `stepNumber + 1`.
let lastStepCount = 0;
```

In the existing `onStepEnd` callback, set it (add one line at the top of the callback body, before the existing `(a) Accumulate text` block):

```ts
lastStepCount = stepNumber + 1;
```

- [ ] **Step 6: Attach the reason to the assistant message metadata**

In the same route, extend the existing `messageMetadata` callback inside `toUIMessageStream`. The current callback handles `finish-step`; add a `finish` branch:

```ts
messageMetadata: ({ part }) => {
  if (part.type === "finish-step") {
    return { usage: part.usage, reasoningEffort: resolvedEffort };
  }
  if (part.type === "finish") {
    return {
      stopReason: harnessStopReason({
        steps: lastStepCount,
        finishReason: part.finishReason,
        contextWrapUp,
      }),
    };
  }
  return undefined;
},
```

Add `harnessStopReason` to the existing import from `@/lib/ai/harness-loop` at the top of the route.

- [ ] **Step 7: Type-check**

Run: `pnpm exec tsc --noEmit`

Expected: no errors. If `part.finishReason` is not present on the `finish` variant of the part union in the installed AI SDK, run `grep -n "type: \"finish\"" node_modules/ai/dist/index.d.ts | head` and use the field that variant actually exposes; do not cast.

- [ ] **Step 8: Run the harness-loop tests once more**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts`

Expected: PASS — all tests, old and new.

---

### Task 3: Commit Stage 1 and verify against the real task

**Why:** the uncommitted timeout work and Tasks 1–2 form one coherent deliverable. This task lands them together and checks the spec's acceptance criterion 1 and 2 (§6.1).

**Files:** none modified — this task commits and verifies.

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: nothing for later tasks (Stage 2 is a separate plan).

- [ ] **Step 1: Review the complete diff**

Run: `git diff`

Confirm the diff contains only:
- `HARNESS_TIMEOUT` (raised timeouts + `chunkMs`),
- `timeoutAbortToErrorPart` + `isTimeoutAbortReason`,
- the flipped and extended `HARNESS_TIMEOUT` tests,
- `harnessStopReason` + its tests,
- the route's `onAbort` logging, `lastStepCount`, and the `finish` metadata branch.

If anything else appears, remove it before committing (Rule 16 — the diff contains only relevant changes).

- [ ] **Step 2: Run the unit project**

Run: `pnpm vitest run --project unit src/lib/ai/__tests__/harness-loop.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/harness-loop.ts \
        src/lib/ai/__tests__/harness-loop.test.ts \
        src/app/api/projects/chat/route.ts
git commit -m "fix(projects): stop killing reasoning runs; surface the stop reason

A per-chunk watchdog at 60s aborted a step whenever the model emitted
nothing for a minute — exactly what a reasoning model does while
thinking. The SDK reports a timeout as an abort, not an error, so
onError never fired and useChat showed a silent stop after ~6 steps.

Reinstates the watchdog at 5 minutes, strictly below stepMs, and
converts a timeout abort into an error part so it reaches the client.
Adds harnessStopReason() and attaches it to the finish metadata so a
natural stop, a step cap, and a context wrap-up are distinguishable."
```

- [ ] **Step 4: Verify the original failure is gone (manual, one run)**

Start the app (`pnpm dev`) and, in Projects, ask it to build a landing page. Expected: the run proceeds past six steps; if it stops, the message carries a `stopReason` of `natural`, `step-cap`, or `context-wrap-up`; if it times out, an error message is shown instead of a silent stop.

Record the observed `stopReason` in the commit's PR description or a follow-up note — this is the spec's §1.1 honesty requirement (the diagnosis was code-reading plus inference until it is reproduced or refuted in a real run).

- [ ] **Step 5: Confirm Stage 1 is complete**

Stage 1 is done when: the landing-page task runs past six steps, every stop is labelled, and the unit project plus `tsc --noEmit` are green. Stage 2 (`docs/superpowers/plans/2026-09-21-project-harness-stage2-durable.md`) starts only after this is observed.

---

## Self-Review

**Spec coverage:** §1.1 root cause (fixed by the pre-existing tree + Task 1) ✔; §5.3 stop-reason semantics (Task 2) ✔; §5.5 chunk watchdog at 5 min, strictly below `stepMs` (Task 1) ✔; §6.1 criteria 1–2 (Task 3 verification) ✔; §7.1 "reproduce, then commit" (Task 3 step 4) ✔. Everything else in the spec is Stage 2 by construction.

**Placeholder scan:** no TBD/TODO; every code step shows the code; the one conditional instruction (Task 2 step 7) names the exact grep to run rather than saying "handle it".

**Type consistency:** `HarnessStopReason` / `HarnessStopReasonInput` / `harnessStopReason` are spelled identically in the test, the implementation, and the route. `HARNESS_MAX_STEPS` is imported, not redeclared. `lastStepCount` is declared once and written once.
