# Root-cause analysis #2 — file-edit latency, inconsistent output, tab-switch death

**Date:** 2026-09-21
**Method:** evidence from `data/logs/yggdrasil.log` (the run after the transport fix) + source reading.
**Predecessor:** `ROOT-CAUSE-slow-and-abort.md` (the abort bug — fixed in `14ae0f1`).

---

## User's report

1. Process now works, but loading `file_operations` is still very slow.
2. Resulting code is inconsistent with many mismatches.
3. Switching tab away and back **stops the run permanently** ("still running" style message).

---

## 1. "Slow file_operations" — the tool is fast; the ROUND TRIPS are slow

Measured over the post-fix run:

| | calls | total | average |
|---|---|---|---|
| Model calls | 44 | **675,438 ms** | 15,351 ms |
| Tool executions | 42 | **925 ms** | 22 ms |

**Tool execution is 0.14% of wall-clock.** `file_operations` averaged single-digit ms (5.3, 2.3, 4.9 ms in the sampled steps). The perceived slowness is **32 `file_operations` calls × ~15 s of model latency each** — every tool call is a full model round trip, and the round trip is the cost.

**The user's hypothesis ("CRUD in one file makes it slow") is not the cause.** A discriminated-union tool is one schema and one round trip per call; splitting it into `read_file`/`write_file`/`edit_file` tools would produce the *same* number of round trips. It would not be faster.

**What actually drives the count:** the model calls `write`/`read` by hallucinated name and the repair layer maps them (`Tool call repaired: write -> file_operations`, twice for `read` in this run). Each is still a round trip. The lever is **fewer, larger calls**, not a different tool shape.

---

## 2. "Inconsistent code, many mismatches" — no verification step exists

The prompt's sections are: Environment Details, Agentic Operating Mode, Project Instructions, Custom Instructions, Tool Hierarchy & Discipline, Read Before Modifying, Surgical Edits, Task Planning & Tracking.

**There is no instruction to verify edits** — no "run the type-checker/build/tests after changing files", and the final-report line only asks the model to state *"anything you could not verify"*, which it can satisfy without verifying anything. Combined with:
- the model making 32 file edits in one run, and
- `write` refusing to clobber (so it must `edit` with exact-match `oldString`),

a mismatch is expected: an `edit` whose `oldString` was reconstructed from memory rather than re-read either fails or lands in the wrong place, and nothing afterwards checks that the file still parses. The harness has **no post-edit verification gate** — grep for `tsc|parse|syntax|validate` in `project-harness-tools.ts` returns nothing.

**This is the actionable cause of "inconsistent/mismatched code": the model is never required to check its own work.**

---

## 3. Tab-switch kills the run — two independent bugs

### 3a. The client aborts the stream on session change (by design, wrong for visibility)

`ProjectWorkspace.tsx:289-305` has an explicit **abort-on-session-switch** effect: when `activeSessionId` changes, it calls the remembered `stop()` of the outgoing stream. Its comment explains the original intent — preventing cross-session contamination when the user switches *sessions* mid-stream.

But this fires on any session-id change, and the effect is the only lifecycle hook. A tab switch that unmounts/remounts the workspace (or any remount that flips `activeSessionId` from `null`) aborts the in-flight generation. There is no `visibilitychange` handling and no distinction between "user switched session" and "component remounted".

### 3b. Projects has NO resume path at all

The server *does* publish a resumable stream — `route.ts:888` calls `publishStream(activeStreamId, sessionId, stream)`.

But:

| Piece | Chat | Projects |
|---|---|---|
| `publishStream` on send | yes | **yes** (`route.ts:888`) |
| Resume endpoint `GET …/[id]/stream` | **yes** (`api/chat/[id]/stream/route.ts`) | **MISSING** |
| Client `resume: true` | **yes** (`ChatArea.tsx:284`) | **MISSING** (`grep resume ProjectWorkspace.tsx` → 0) |

So Projects pays for a published stream and can never re-attach to it. `session.activeStreamId` is set and then, with no client ever attaching, the run appears dead; a later send hits the **409 "Session stream is already in progress"** (`route.ts:166`, `:473`) — which is exactly the "still running" the user saw, and it persists until the registry entry expires.

**The 409 is a symptom of the missing resume path, not a separate bug.**

---

## Fix plan

| # | Fix | Addresses | Notes |
|---|---|---|---|
| 1 | Add `GET /api/projects/chat/[sessionId]/stream` mirroring the chat route's resume endpoint | 3b | Small, direct copy of a proven pattern |
| 2 | Client: pass `resume: true` with the session id as the resume key, mirroring `ChatArea` | 3b | Restores the published stream's purpose |
| 3 | Stop aborting on remount: abort only on a real **session switch** (previous session existed and differs), never on mount/remount | 3a | The existing guard already returns early when `previous == null`; needs verification that remount does not bypass it |
| 4 | Add a **verification gate** to the prompt: after editing, run the project's type-check/build (or at minimum re-read the changed region) before declaring done | 2 | Highest value for output quality |
| 5 | Prompt: keep batching edits, and always re-`read` the exact region immediately before `edit` so `oldString` is copied, not recalled | 2, 1 | Reduces failed edits and their retry round trips |

**Not a fix:** splitting `file_operations` into separate CRUD tools. It would not reduce round trips (the actual cost) and would add tool-surface area for the model to hallucinate across — the same failure mode the earlier feature revert was about.
