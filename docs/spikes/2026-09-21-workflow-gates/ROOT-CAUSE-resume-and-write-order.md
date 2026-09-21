# Root-cause analysis #3 — 409 on tab return; write-before-edit ordering

**Date:** 2026-09-21
**Predecessor:** `ROOT-CAUSE-edits-and-resume.md` (resume endpoint added in `7dd6f0d`).

---

## 1. The 409 persists because `resume` never re-fires

`7dd6f0d` added the resume endpoint and `resume: Boolean(activeSessionId)`. That was necessary but **not sufficient**, and the SDK explains why:

```js
useEffect(() => {
  if (resume) {
    chatRef.current.resumeStream();
  }
}, [resume, chatRef]);   // @ai-sdk/react/dist/index.js:423
```

`resumeStream()` runs **once, on mount or when `resume` changes**. A tab switch does **not** remount `ProjectWorkspace` (it has no `key`, and `page.tsx:227` keeps it mounted), and `resume` stays `true`, so the effect never re-runs. Nothing re-attaches on tab return. Verified: no `visibilitychange` listener anywhere in the Projects path.

### What happens instead, and why it produces 409

On returning to the tab the client re-renders from its last known messages, and `sendAutomaticallyWhen` fires:

```js
sendAutomaticallyWhen: (chatState) =>
  lastAssistantMessageIsCompleteWithToolCalls(chatState) || …
```

That predicate is true when the last step's tool calls are all `output-available`/`output-error` (`ai/dist:18420`) — which is exactly the state of a transcript whose connection dropped *after* tool results arrived but *before* the run finished. So the client **POSTs a new turn** while the original run is still going server-side, and the route correctly refuses:

```
POST /api/projects/chat → 409 { error: "Session stream is already in progress" }
```

**The 409 is the client taking the wrong path (POST) because the right path (re-attach) was never triggered on focus.** It is not a server-side locking bug.

**Diagnosability gap found:** neither 409 site logs anything (`route.ts:164`, `:467` return before any `syslog`), so this failure left no server-side trace — which is why it had to be found by reading source.

---

## 2. write-before-edit ordering wastes a round trip per file

The user reports: read → create/write → "already exists" error → edit.

Cause: **there is no `create` action.** A model that intends to *create* a file has only `write`, and `write` now refuses an existing file (added in `6587eae`). So when the file already exists, the model burns one full round trip (~15 s) discovering that, then switches to `edit`.

The guard is right; the model's choice of `write` for an existing file is the waste. The prompt does say to use `edit` on existing files, but the model does not always know a file exists — and after a successful `read` it *does* know, yet nothing connects those two facts.

**Not a fix:** adding a separate `create` action. It would not remove the round trip (the model would call `create`, get the same refusal, then `edit`), and it widens the tool surface the model already hallucinates across (`Tool call repaired: write -> file_operations`).

---

## Fixes

| # | Fix | Addresses |
|---|---|---|
| 1 | Wire `visibilitychange` (and focus) to `resumeStream()` so returning to the tab re-attaches instead of POSTing | 1 |
| 2 | Log both 409 returns, so the next occurrence is visible in `data/logs/yggdrasil.log` | 1 (diagnosability) |
| 3 | Prompt: a file you just read exists — `edit` it, never `write`; and never `write` a path you have seen in a `list`/`find`/`grep` result | 2 |
