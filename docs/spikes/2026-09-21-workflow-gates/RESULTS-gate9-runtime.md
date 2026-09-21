# Spike results — Stage 2 gate 9 runtime (provider instance across the step boundary)

**Date:** 2026-09-21
**Method:** isolated spike project in a throwaway git worktree, `@workflow/vitest@5.0.0-beta.50` +
`workflow@5.0.0-beta.50` + `@ai-sdk/workflow@2.0.28` + `ai@7.0.97` + `@ai-sdk/openai-compatible@3.0.35`.
Real workflow transforms, in-process Local World, no network (provider pointed at a dead port).

---

## Question

Rev 6 claimed: *"a provider instance cannot cross the step boundary; the model must be a string or a
step-as-factory."* Is that accurate for a **real** provider — and specifically for yggdrasil's shape,
where the model is built by its own registry and wrapped in `wrapLanguageModel`?

## Result: the claim was **partly wrong**, and the real cause is different

Three models were put through `WorkflowAgent`:

| Model | Outcome |
|---|---|
| `wrapLanguageModel({ model: provider.chatModel(...), middleware })` — **yggdrasil's exact shape** | `Failed to serialize step arguments at path ".args[1].doGenerate"` |
| Bare `provider.chatModel(...)` (no wrapper) | Serialization **succeeds**, then: `Class "class//@ai-sdk/openai-compatible@3.0.35//OpenAICompatibleChatLanguageModel" not found. Make sure the class is registered with registerSerializationClass.` |
| Locally-defined class implementing the protocol | Same "class not found" for the provider class it builds |

### What each failure actually means

1. **The middleware wrapper is the real blocker for yggdrasil.** `wrapLanguageModel` produces a plain
   object whose `doGenerate`/`doStream` are functions, and functions are not serializable — hence
   `.args[1].doGenerate`. This is a genuine, direct hit on `chatModelForEntry()` in
   `src/lib/ai/provider.ts:180-190`, which wraps every model in `extractReasoningMiddleware`.

2. **A bare provider instance is *designed* to serialize.** `@ai-sdk/openai-compatible` implements
   `static [WORKFLOW_SERIALIZE]` / `[WORKFLOW_DESERIALIZE]` (dist lines 450/456), serializing
   `{ modelId, config }`. The failure is **not** a serialization failure — it is a **class-registration**
   failure: the class lives in `node_modules` and is never part of the transformed app graph, so the SWC
   plugin never discovers it.

3. **Registration is the missing piece, and it has a public API.** `workflow`'s docs state the SWC plugin
   auto-registers classes implementing the symbols, with a `classId` *derived from file path and class
   name* — which is exactly why a `node_modules` class is missed. `@workflow/core` exposes
   `registerSerializationClass(classId, cls)` and `aliasSerializationClass(classId, cls)` for programmatic
   registration.

## Consequences for the spec (§3.4.0 must be corrected)

1. **"Provider instance cannot cross the boundary" is too strong.** A bare provider instance can — it
   serializes natively. The accurate statement is: *a model wrapped in `wrapLanguageModel` cannot, because
   the wrapper's functions are not serializable; and a provider class from `node_modules` additionally
   needs serialization-class registration.*

2. **yggdrasil has two concrete options**, both now grounded in evidence:
   - **Drop the wrapper on the durable path**, and register the provider class via
     `registerSerializationClass` / `aliasSerializationClass` so the step bundle can deserialize it. The
     reasoning middleware would then move into a `prepareStep`-independent place, or be re-applied inside
     the step.
   - **Step-as-factory (still valid):** pass serializable constructor inputs and build the model *inside*
     the step, where `wrapLanguageModel` is fine because the wrapper never crosses a boundary. This avoids
     the registration problem entirely and keeps the middleware.

   The step-as-factory remains the lower-risk choice: it needs no class registration and preserves the
   existing middleware behaviour. But it is no longer the *only* option, and the reason is now precise.

3. **`toolsContext` reaching `execute` is still unverified.** Every run failed before a tool could execute
   (the model never produced a turn), so `readSeen()` was empty in all cases. This remains the one open
   sub-question, unchanged from the previous spike.

## What is now settled vs open

**Settled:**
- The model is a step argument and must cross the boundary (`doStreamStep` arg 2).
- `wrapLanguageModel` breaks that crossing — directly relevant to `provider.ts`.
- A bare provider instance serializes natively via `WORKFLOW_SERIALIZE`.
- A `node_modules` provider class needs registration; the API exists.

**Open:**
- Whether `toolsContext` arrives at `execute` as `context` at runtime (needs a turn to complete).
- Whether the chosen model strategy (factory vs drop-wrapper+register) preserves reasoning-middleware
  behaviour on the durable path.
