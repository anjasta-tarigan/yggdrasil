# Root-cause analysis — Projects harness "very slow, inconsistent, aborts at step 8"

**Date:** 2026-09-21
**Method:** systematic debugging (Phase 1–2), evidence from `data/logs/yggdrasil.log` + `data/logs/yggdrasil.log.1` and the installed `ai@7.0.77` source.

---

## The abort: root cause FOUND (a bug I introduced in Stage 1)

**Symptom:** `Harness run aborted: TimeoutError: Chunk timeout of 300000ms exceeded` after 8 steps.

**Timeline from the log (the failing run):**

| Time | Event |
|---|---|
| 22:11.673Z | Step 5's model call started |
| 24:46.121Z | Step 5's model call ended — **154.4 s**, `outputTokensPerSec=0` |
| 24:48.175Z | Step 7's model call started |
| 29:56.917Z | **aborted** — `Chunk timeout of 300000ms exceeded` |

**Root cause:** `chunkMs` (the per-gap watchdog) is armed on the **whole step's abort signal**, not just the model stream, and it is only reset by *output chunks* — `text-delta`, `reasoning-delta`, `tool-input-delta`, `file`, `tool-call`. `tool-result` is **not** an output chunk (`isOutputChunk2`, `ai/dist/index.js:8817`), and `resetChunkTimeout` has exactly one call site (`:9949`, inside the chunk loop).

Consequences, both verified in source:

1. **A slow model call that streams nothing for > `chunkMs` aborts the step.** The provider returned no deltas for 300 s (a 154 s call was already observed), so the watchdog fired. This is what the user hit.
2. **A long tool execution can also abort the step** — the timer is not cleared between the model stream ending and `executeTools` running (`cleanupStepTimeouts` is called only at stream end/error/cancel: `:10077`, `:10130`, `:10167-10172`). A `bash` command approaching `HARNESS_BASH_TIMEOUT_MS` (240 s) is within 300 s of tripping it, and any future raise of the bash timeout would trip it outright.

So the Stage 1 "reinstatement" restored dead-socket detection but bound it to the **step**, not the socket. The spec (§5.5) claimed it was a *per-gap* watchdog; that claim is true of the SDK's intent but the gap it measures includes tool execution and model-silence alike.

**This is not a timeout-value problem.** Raising `chunkMs` to 10 min would mask it and re-create the original silent-stop failure mode for genuinely dead sockets. The fix belongs at the transport layer.

---

## The slowness: root cause SPLIT into two, and the user's hypothesis was half right

### Dominant factor: provider latency (not a code bug)

Measured over the failing run: **model total 178,289 ms vs tool total 273 ms.** Tools are ~0.15% of wall-clock. Individual model calls ranged 1.9 s → **154.4 s**, with `outputTokensPerSec=0` on the slow ones.

The configured default is `ps/poolside/laguna-xs-2.1` via the `9Router` openai-compatible provider (`data/providers.json`). A model that takes 154 s for one step and emits no deltas for 300 s is the dominant cause of "very slow and inconsistent". **No code change fixes this** — it is a provider/model choice.

### Secondary factor: unnecessary model round-trips (a real design issue)

`file_operations` was called **700 times** across 289 runs (~2.4/run, but the failing landing-page run shows the pattern: many small writes). Each call costs a full model round-trip (1.9–154 s). The tool already supports an `edit` action (exact-substring replace, `project-harness-tools.ts:99-103`), but the prompt does not push it, so the model reaches for `write` (full-file rewrite) instead. Fewer, larger operations would cut the round-trip count — the "not as fast as Claude Code" complaint.

### Contributing factor: `smoothStream({ chunking: "word", delayInMs: 2 })`

`route.ts:617`. At 2 ms/word, a 3,000-word response adds ~6 s of artificial delay per turn. Small next to provider latency, but it is pure added latency with no functional value.

### Contributing factor: effort is pinned to `xhigh`, never auto

`route.ts:308-332`. `effort === "auto"` is honoured **only if the client sends the string `"auto"`** — and the Projects client sends **no `effort` field at all** (`ProjectWorkspace.tsx:582-586` sends only `projectId`, `sessionId`, `model`). So every Projects run falls through to the hardcoded `resolvedEffort = "xhigh"`, i.e. a 32,000-token thinking budget (`reasoning.ts:4`), regardless of task. The auto-classifier exists but is unreachable from the Projects UI.

---

## What is NOT the cause (ruled out with evidence)

- **Tool execution speed.** Max observed tool duration across both logs: 128 ms (`file_operations`); `bash` max ~590 ms. Not slow.
- **Tool withholding.** `active tools: (none)` appears in successful runs too — it is a logging artifact of the `onStepStart` callback, not actual withholding.
- **Running "from the browser".** The route is a server route; the browser only receives the stream. No evidence of client-side cost.
- **Model picker missing.** It exists and is wired (`ProjectWorkspace.tsx:913`), and is already sent in the body (`:585`). So "let the user pick the model like regular chat" is **already satisfied** — the issue is the *default*, not the absence of a picker.

---

## Fix plan (smallest first, root cause not symptom)

| # | Fix | Addresses | Risk if wrong |
|---|---|---|---|
| 1 | Move dead-socket detection to `provider-fetch.ts` as an idle-byte timeout; stop relying on `chunkMs` | The abort, correctly — detects a dead socket without capping tool/model time | Low; the SDK watchdog stays as a backstop |
| 2 | Default `effort` to `"auto"` server-side when the client omits it (keep explicit values honoured) | Unreachable auto-classification; per-step thinking cost | Low; `auto` already has a tested classifier |
| 3 | Remove `smoothStream` `delayInMs: 2` (or set 0) | ~6 s/turn of artificial latency | Cosmetic only |
| 4 | Prompt + schema guidance to prefer `edit` over `write`; allow multi-file ops per call | Round-trip count ("not as fast as Claude Code") | Medium; prompt change needs eval to confirm |
| 5 | (Optional) AI Elements `Task`/`Queue` for the task list UI | User's optional ask | Cosmetic |

Fixes 1–3 are small and independent. Fix 4 needs a before/after measurement on the same task.
