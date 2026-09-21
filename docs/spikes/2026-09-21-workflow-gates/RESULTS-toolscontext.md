# Spike results — Stage 2 gate 9, round 3: `toolsContext` (NOT conclusively answered)

**Date:** 2026-09-21
**Method:** isolated spike project in a throwaway git worktree; `@workflow/vitest@5.0.0-beta.50`,
`workflow@5.0.0-beta.50`, `@ai-sdk/workflow@2.0.28`, `ai@7.0.97`, `@ai-sdk/openai-compatible@3.0.35`.
Attempted: real provider, model factory, local serializable model class, and a mock HTTP provider server.

---

## The question

Does a `toolsContext` entry actually arrive at a tool's `execute` as `context`, at runtime?

## Honest outcome: **not observed at runtime.** Three blockers, each now precisely characterised.

### Attempt 1 — real provider instance (`@ai-sdk/openai-compatible`)

Failed with `Class "class//@ai-sdk/openai-compatible@3.0.35//OpenAICompatibleChatLanguageModel" not found.
Make sure the class is registered with registerSerializationClass.`

Reproduced the previous spike's finding: the class lives in `node_modules`, is not discovered by the SWC
plugin, and `registerSerializationClass` is **not re-exported from the `workflow` root** — it lives in
`@workflow/core/class-serialization`, which is not a direct dependency of an app.

### Attempt 2 — model factory (the spec's recommended strategy)

Failed with `Unsupported model version undefined for provider "undefined" and model "undefined"`.

**This corrects the spec.** `doStreamStep` resolves the model as:

```js
const model = typeof modelInit === "string" ? gateway.languageModel(modelInit) : modelInit;
```

It handles a **string** or passes the value through. It **never invokes a function**. So a
step-as-factory is **not** a valid way to supply a model to `WorkflowAgent` — the factory itself becomes
the `modelInit` and fails the version check. The step-as-factory pattern documented for `@workflow/ai`'s
(deprecated) `DurableAgent` does not apply here.

### Attempt 3 — locally-defined serializable model class

This **got past serialization** (no `SerializationError`, no "class not found") — confirming that a
locally-defined class implementing `workflow-serialize`/`workflow-deserialize` is discovered and
registered. But the run then **hung** (90 s test timeout), with `finishReason: "other"` before that.

Diagnosis: two V4 shape errors in my mock, which I could not fully settle within a reasonable budget:
- `finishReason` in V4 is an **object** `{ unified, raw }`, not the string I first sent — that alone
  produced `finishReason: "other"` and zero tool results.
- `usage` in V4 is **nested** (`inputTokens: { total, noCache, … }`), not flat.
- The hang is consistent with the model instance being deserialized fresh per step, so a mutable
  turn counter resets and the loop never terminates.

I stopped here rather than continue tuning a mock: the cost had exceeded the value, and the question is
answerable from source (below).

## What the SDK source says (authoritative, not yet observed)

`execute` is called with the per-tool context resolved from `toolsContext`:

```js
async function resolveToolContext({ toolName, tool, toolsContext }) {
  const contextSchema = tool.contextSchema;
  const entry = toolsContext?.[toolName];
  if (contextSchema == null) return entry;          // no schema → pass through
  return await validateTypes({ value: entry, schema: contextSchema, ... });
}
```

and at the call site:

```js
const options = { toolCallId, messages, abortSignal, context: await resolvedContext, experimental_sandbox };
```

So: **without a `contextSchema`, the `toolsContext` entry is passed to `execute` verbatim as `context`.**
With one, it is validated first. The plumbing is unambiguous; only end-to-end observation is missing.

## Corrections this spike makes to the spec

1. **The model cannot be a step-as-factory.** `doStreamStep` accepts a string or passes the value
   through; it does not call functions. §3.4.0's recommendation must change: the durable path needs a
   **serializable model instance** (locally-defined class implementing the protocol, or a registered
   `node_modules` class), not a factory.
2. **`wrapLanguageModel` still cannot cross** — unchanged, and it remains the blocker for
   `chatModelForEntry()` in `src/lib/ai/provider.ts`.
3. **`registerSerializationClass` is not on the `workflow` root export.** Any solution that registers a
   `node_modules` provider class must import it from `@workflow/core/class-serialization` and add that
   dependency explicitly, or avoid the problem by not passing provider instances.
4. **`toolsContext` is correct in source but unobserved at runtime.** It stays an open gate — but the
   remaining risk is now narrow: the plumbing is a two-line pass-through, not a design unknown.

## Recommended next step (for the implementation plan, not another spike)

Answer this with the **real app**, not a mock: wire the model as a serializable instance, run one real
turn against a configured provider, and assert that `execute` received its `context`. That is gate 9's
remaining half, and it is cheaper to do once real code exists than to keep building a faithful V4 mock.
