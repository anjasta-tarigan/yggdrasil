# ONNX Model Installer: HuggingFace Search, One-Action Install & Auto-Resolution Design

## 1. Executive Summary

This specification defines a model-installer subsystem for Yggdrasil's on-device ONNX
embedding and reranker models. A user searches HuggingFace, picks a repository, and the
system downloads every file that model needs — graph, external weights, tokenizer,
pooling config — into the correct local layout in one action.

The feature solves three concrete problems:

1. **Multi-file confusion.** An ONNX model is not one file. It needs `tokenizer.json`, and
   for sentence embedders a pooling declaration, and for large models a sibling
   `<name>.onnx_data` weights file. Today the user must know this and place each file by
   hand. The installer derives the full file set from the HuggingFace tree API.
2. **The pooling guessing game.** Sentence-transformer ONNX exports do not record their
   pooling mode in the graph. The existing tiered resolver (graph shape → sidecar config →
   user selection) leaves the third tier firing often, because the most-downloaded repos
   (`Xenova/*`, `transformers.js` mirrors) ship **no** `1_Pooling/config.json`. Those repos
   do declare `base_model:<repo>` in their tags, and that upstream repo usually **does**
   ship the sidecar. The installer fetches it automatically, so the common path stops
   asking.
3. **Unverified installs.** A truncated or wrong-variant download currently installs
   "successfully" and fails later, at query time, silently degrading retrieval. The
   installer verifies every file against the HuggingFace LFS digest and then proves the
   model actually loads by running it.

The tier-3 pooling dropdown is **retained as an escape hatch** for models that declare
nothing and have no base tag. The installer does not replace it; it makes it rare.

---

## 2. Verified Constraints

Every load-bearing claim below was verified against the source and the live HuggingFace API
during design. Claims that failed verification are recorded with their corrections.

### 2.1 Path resolution (verified — corrects an earlier design error)

| Resolver | Searches | Parent fallback? |
| :--- | :--- | :--- |
| `tokenizerPathFor` (`tokenizer.ts:58-60`) | `dirname(modelPath)/tokenizer.json` only | **No** |
| `resolvePoolingMode` (`pooling.ts:120-121`) | `[modelDir, dirname(modelDir)]` | **Yes** |
| `onnxModelSizeBytes` (`embeddings.ts:148`) | `${modelPath}_data` — adjacent | n/a |
| `discoverEmbeddingModels` (`embeddings.ts:186-211`) | 1 level deep | n/a |

**Consequence:** a verbatim HuggingFace mirror (`<repo>/onnx/model.onnx` with
`tokenizer.json` at `<repo>/`) fails tokenization. `tokenizerPathFor` resolves to
`<repo>/onnx/tokenizer.json`, gets `ENOENT`, and `loadTokenizer` throws
`TokenizerUnavailableError` (`tokenizer.ts:430-434`). `embeddings.ts:746-757` catches that
and returns `null` — **the memory is stored with no vector**. This is a silent
retrieval-degradation failure, which is why the layout below is flattened rather than
mirrored.

Additionally, `discoverEmbeddingModels` scans one level, so `<org>/<name>/onnx/model.onnx`
(depth 3) is never auto-discovered under **any** layout.

### 2.2 Storage layout (decided)

One directory per model, all sidecars co-located, exactly one level under the canonical dir:

```
data/models/embedding/Xenova--all-MiniLM-L6-v2/
  model_quantized.onnx
  tokenizer.json
  1_Pooling/config.json        ← fetched from base_model:<repo> when absent
  config.json
  manifest.json
```

The org is flattened into the directory name with `--` so the model stays at depth 1 and
names remain collision-free across orgs.

This is the only layout needing **zero changes** to any *path* resolver: `tokenizerPathFor`
finds the co-located tokenizer, pooling's parent fallback finds the co-located `1_Pooling`,
`onnxModelSizeBytes` finds the adjacent `_data` file, and the existing one-level scan finds
the model at depth 2.

The manifest gate described in §4.2 is a separate, orthogonal addition to discovery — not a
consequence of the layout.

### 2.3 HuggingFace API (verified live)

| Endpoint | Returns | Notes |
| :--- | :--- | :--- |
| `GET /api/models/{repo}/tree/main?recursive=true` | `{type, oid, size, path}` + `lfs` | **Mandatory** for sizes/hashes |
| `GET /api/models/{repo}` | `siblings`, `tags` | `siblings` carries **only** `rfilename` — no size |
| `GET /api/models?search=&filter=transformers.js` | ids + metadata | **No `siblings`** unless `full=true` |

- **Integrity field is `lfs.oid`** — the file-bytes sha256. Verified byte-for-byte against
  `sha256sum`. `xetHash` is a different hash and **must not** be used for verification.
- **Search must append `full=true`** to get file lists in one round trip; otherwise it costs
  one extra tree request per result.
- **Redirects must be followed manually.** LFS files 302 **cross-host** to
  `us.aws.cdn.hf.co`; small non-LFS files 307 **same-host** to `/api/resolve-cache/...`.
  Both shapes occur. The existing `guardedFetch` cannot be reused: it sets
  `redirect: "error"` (`http.ts:82`) and its allowlist (`http.ts:20-28`) does not contain
  `huggingface.co` — it would reject before redirect handling even matters.
- **Range/resume works:** `Range: bytes=N-` survives the redirect and returns `206` with
  `content-range` and `accept-ranges: bytes`.

### 2.4 Variant support on `onnxruntime-node` CPU (verified — corrects an earlier design error)

Measured sizes for `Xenova/multilingual-e5-small`:

| File | Size | CPU verdict |
| :--- | ---: | :--- |
| `model_int8.onnx` | 118.1 MB | Loads (QInt8) |
| `model_quantized.onnx` | 118.3 MB | Loads — **same QInt8 class as int8** |
| `model_uint8.onnx` | 118.1 MB | Loads (QUInt8) |
| `model_q4f16.onnx` | 204.8 MB | Loads, but larger than int8 |
| `model_fp16.onnx` | 235.3 MB | **Excluded — native abort on CPU** |
| `model_bnb4.onnx` | 397.3 MB | Loads, but larger than int8 |
| `model_q4.onnx` | 398.6 MB | Loads, but larger than int8 |
| `model.onnx` | 470.3 MB | Loads (fp32) |

Two corrections to the intuitive ladder:

- **`int8` and `quantized` are the same QInt8 class** — they are one rung, not two.
  (`transformers.js` maps Q8 → suffix `quantized`; `int8` is QI8. Both are QInt8 weights.)
- **fp16 must not be in the CPU ladder.** Its failure is a *native graph-optimization
  abort* inside `InsertedPrecisionFreeCast_`/`SimplifiedLayerNormFusion` — a process-level
  abort, not a catchable JS error. A `try/catch` smoke test **cannot advance past it**; the
  process dies. fp16 belongs to WebGPU, not CPU.

`q4`/`q4f16`/`bnb4` do load on ORT ≥ 1.16.2 (the project pins `^1.29.0`), but are **larger**
than int8 for embedding models because only MatMul weights are quantized, not the embedding
table. They are deprioritized, never auto-picked.

### 2.5 Base-model pooling asymmetry (verified)

| Repo | Ships `1_Pooling/config.json`? |
| :--- | :--- |
| `Xenova/multilingual-e5-small` | **No** |
| `Xenova/all-MiniLM-L6-v2` | **No** |
| `intfloat/multilingual-e5-small` (the base) | **Yes** (+ `modules.json`) |
| `sentence-transformers/all-MiniLM-L6-v2` (the base) | **Yes** |

`Xenova/*` repos carry `base_model:intfloat/multilingual-e5-small` in their tags. The
installer resolves pooling from the base repo, not the derived one.

---

## 3. Architecture

### 3.1 Module map

New family under `src/lib/models/`, generic over model kind (`embedding` | `reranker`):

| Module | Responsibility | Purity |
| :--- | :--- | :--- |
| `hf-client.ts` | `searchModels`, `getModelTree`, `getModelInfo`. Host allowlist (strict suffix matching), **manual per-hop redirect re-validation**, timeouts, byte caps. | impure (network) |
| `download.ts` | One file: stream → `.part`, Range-resume, size + `lfs.oid` verification, atomic rename, `ENOSPC` cleanup. | impure (disk) |
| `installer.ts` | `planInstall()` — decide *what* to fetch. `executeInstall()` — drive downloads, isolated smoke test, manifest, progress. | **plan is pure** (client injected) |
| `store.ts` | Layout, manifest read/write, `discoverModels(kind)`, orphaned directory / `.part` sweep. | impure (disk) |
| `smoke.ts` | Orchestrates smoke test in an isolated child process (`child_process.fork`) with timeout and crash signal detection (`SIGSEGV`, `SIGABRT`, `SIGFPE`). | impure (process) |
| `smoke-worker.ts` | Minimal child-process script: loads model via `ort.InferenceSession.create()`, runs dummy probe, returns output rank over Node IPC, exits immediately. | impure (native) |
| `jobs.ts` | In-memory job registry (globalThis-anchored, HMR-safe like `onnx-session.ts`), tracking active jobs, variant collision detection (409 Conflict), byte reservations, abort, progress snapshots. | stateful |

```
src/lib/models/
  hf-client.ts  download.ts  installer.ts  store.ts  smoke.ts  smoke-worker.ts  jobs.ts
src/app/api/models/
  search/route.ts              GET  ?q=&kind=
  inspect/route.ts             POST {repo,kind} → plan preview
  install/route.ts             POST {repo,kind,variant?} → {jobId}
  install/[jobId]/route.ts     GET progress · DELETE cancel
```

### 3.2 Data flow

```
search ─→ user picks repo ─→ inspect (tree API → planInstall)
                                   │
              ┌────────────────────┴────────────────────┐
              │  plan: files + variant + pooling source │
              └────────────────────┬────────────────────┘
                                   ↓ user confirms
              install → job → download each file (stream, Range-resume)
                                   ↓
              verify size + lfs.oid → smoke test (create+run+release)
                                   ↓
              atomic rename → manifest written LAST
                                   ↓
              store.discoverModels() picks it up — no restart
```

The plan is pure and takes an injected client, so variant selection, base-model pooling
lookup, and external-data detection are all unit-testable against a fake tree.

### 3.3 Dedup

`store.discoverModels(kind)` becomes the single discovery path. `discoverEmbeddingModels()`
and the reranker's equivalent become thin wrappers preserving their current exported shapes,
so existing UI and tests keep working.

Note the two currently differ and the shared store must reconcile them: embedding discovery
scans one level (`embeddings.ts:186-211`), while reranker discovery is **top-level only with
no recursion** (`reranker.ts:107-144`). Under the flattened layout a downloaded model sits at
depth 2, so the reranker wrapper must gain the same one-level scan or its installed models
will not be found.

---

## 4. Detailed Specifications

### 4.1 `planInstall(repo, kind, {variant?, client})`

Returns a pure plan. Decision order:

**1. Variant selection.** Preference ladder over files the tree actually contains:

```
int8 | quantized   →  uint8   →  fp32 (model.onnx)
```

- `int8`/`quantized` are treated as one rung (same QInt8 class); pick whichever exists,
  preferring the smaller file when both do.
- **fp16 is excluded** from the CPU ladder (native abort — see §2.4). The "▸ choose a different
  variant" advanced override also labels fp16 as "Disabled (CPU incompatible)" unless a non-CPU
  execution provider (e.g. WebGPU) is explicitly configured.
- `q4` / `q4f16` / `bnb4` are excluded from auto-pick; they are larger than int8 for
  embedding models. Available via the advanced override only.
- The **50 MB gate is lowered to 10 MB** (§4.6) so quantized MiniLM (22.9 MB) is admissible
  instead of forcing the 90 MB fp32 download.

**2. Companion files** (fetched when present in the tree):

- `<chosen>.onnx_data` — **external weights; same basename, must land adjacent.**
  bge-m3 is 607 KB of graph + ~2.2 GB of data; omitting this yields an unloadable model.
- `tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`, `config.json`
- `sentencepiece.bpe.model` / `spiece.model` / `vocab.txt` when present
- `quant_config.json` / `quantize_config.json` when present

**3. Pooling sidecar resolution** (three steps, then defer):

```
repo has 1_Pooling/config.json?            → use it
else tags declare base_model:<repo>?       → fetch sidecar from the base repo
else                                        → defer to the smoke test / user selection
```

Parse both `base_model:<repo>` and `base_model:quantized:<repo>` tag forms, preferring the
non-quantized base.

**4. Layout: Role Contract Mapping.** Destination paths are derived strictly by explicit role
contracts rather than preserving arbitrary HuggingFace tree subpaths or naive basename flattening:

| Role | Tree Match | Local Destination |
| :--- | :--- | :--- |
| `graph` | `*.onnx` | `<targetDir>/<basename>` (matches `/^[a-zA-Z0-9_.-]+\.onnx$/`) |
| `graph-data` | `*.onnx_data` | `<targetDir>/<graphBasename>_data` (must sit adjacent) |
| `tokenizer` | `tokenizer.json` | `<targetDir>/tokenizer.json` (satisfies `tokenizerPathFor`) |
| `pooling` | `1_Pooling/config.json` | `<targetDir>/1_Pooling/config.json` (subpath preserved) |
| `companion` | In static allowlist | `<targetDir>/<basename>` |

Companion allowlist: `{"config.json", "tokenizer_config.json", "special_tokens_map.json", "sentencepiece.bpe.model", "spiece.model", "vocab.txt", "quant_config.json", "quantize_config.json", "modules.json"}`.

**5. Estimated total size**, for the pre-install disk check and the UI.

### 4.2 `executeInstall(job, plan)`

**Orphan Sweep:** Before initiating an install into `<targetDir>` (and on server startup),
`store.ts` purges unmanifested directories that have no active job in `jobs.ts`, and deletes
any orphaned `*.part` files inside `<targetDir>`. This cleanly reclaims space after server
crashes, power cuts, or uncatchable process aborts.

Per file: stream to `<targetPath>.part` inside `<targetDir>` → verify byte size against the
tree's `lfs.size` → verify sha256 against `lfs.oid` → atomic rename. **The manifest is written
last and is the completion marker** — discovery requires a valid manifest, so a half-finished
install can never appear in the dropdown.

**Job Identity & Variant Conflicts (Rule 17):**
Jobs are keyed by target directory / `${kind}:${repo}`. Because differing variants target the
exact same directory (`data/models/<kind>/<org>--<name>/`), they cannot run concurrently without
file collisions:
1. **Same variant requested:** Joins the active in-flight job idempotently and returns the existing `jobId`.
2. **Different variant requested:** Rejects immediately with **HTTP 409 Conflict** (`JobConflictError`).
   The response states that variant X is actively installing and instructs the caller to wait for
   completion or explicitly cancel it via `DELETE /api/models/install/[jobId]`.

**Disk Pre-check & Reservations:**
The pre-check is an advisory fast-fail check subject to point-in-time TOCTOU races. To prevent
concurrent-install races, `jobs.ts` tracks `activeJobsBytesReserved` across all active jobs,
deducting pending allocations from available space. Additionally, `download.ts` handles `ENOSPC`
stream errors gracefully by cleaning up the active `.part` file and throwing `InsufficientDiskError`.

### 4.3 Smoke test (`smoke.ts` & `smoke-worker.ts`) — the correctness gate

After download, verify the model by running a dummy inference. Because ONNX graphs from
untrusted sources can trigger native crashes (`SIGSEGV`, `SIGABRT`, `SIGFPE` from CVE-2026-14647
heap overflows, zero-stride division faults, or unhandled operator assertions), the smoke test
**must run in an isolated child process** via `child_process.fork()`:

```ts
// src/lib/models/smoke.ts (Orchestrator in host process)
export async function runSmokeTest(modelPath: string): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    const workerPath = path.resolve(import.meta.dirname, "./smoke-worker.ts");
    const child = fork(workerPath, [modelPath], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [], // clean flags, no debug port inherit
    });

    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      resolve({ ok: false, error: "Smoke test timed out after 30s" });
    }, 30_000);

    child.on("message", (msg: WorkerResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ ok: true, outputDims: msg.outputDims });
    });

    child.on("exit", (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Native aborts (SIGSEGV, SIGABRT, SIGFPE, SIGILL) are caught here
      if (signal || (code !== null && code !== 0)) {
        resolve({
          ok: false,
          error: `Native crash during model initialization: ${signal ? `signal ${signal}` : `exit code ${code}`}`,
          isCrash: true,
        });
      }
    });
  });
}
```

```ts
// src/lib/models/smoke-worker.ts (Isolated child process)
const modelPath = process.argv[2];
const ort = await loadOrt();
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ["cpu"],
  enableCpuMemArena: false,
  enableMemPattern: false,
  executionMode: "sequential",
});
const out = await session.run(probeFeeds(session.inputNames));
// OrtSession.run type erases dims; cast to read real rank for pooling tier 1
const dims = (out.last_hidden_state ?? out.output ?? out.sentence_embedding)?.dims ?? [1, 0];
if (process.send) process.send({ outputDims: dims });
await session.release();
process.exit(0);
```

**Why child process isolation is mandatory:**
1. **Host server protection:** If a malformed or incompatible model triggers a native `abort()`
   or memory fault inside C++ ONNX Runtime, only the child process dies. The host Next.js server,
   all active chat sessions, and the install job survive.
2. **True fallback ladder execution:** Because the parent process stays alive when a child crashes,
   the fallback ladder can actually advance to the next variant without taking down the server.
3. **Guaranteed OS memory reclamation:** V8 GC and `session.release()` cannot reclaim glibc arena
   memory (ort#25325, bloated RSS by 9GB in tests). When the child process exits, the operating
   system kernel unmaps 100% of the native model allocations instantly.
4. **Worker threads do NOT isolate native crashes:** `worker_threads` share process address space
   and signal handlers; a `SIGSEGV` or `abort()` in a worker thread terminates the entire host process.
   Only an OS process boundary (`fork`) provides isolation.

**Fallback ladder:** on smoke-test failure, advance to the next variant automatically, up to
two attempts. A native abort (process signal exit) marks that variant unusable and advances to
the next without crashing the host. Because each rung can cost 100–470 MB, the ladder is ordered
by size and the UI states the variant being attempted.

**Cost:** ~2–5 s for an int8 model. Paid once, at install.

### 4.4 Errors (typed; Rule 02 — no silent fallbacks)

| Condition | Error | Behavior |
| :--- | :--- | :--- |
| HF unreachable / timeout | `HfUnreachableError` | Retryable; names the host |
| Repo not found / private | `HfRepoNotFoundError` | "check the spelling, or it may be private" |
| No `.onnx` in repo | `NoOnnxVariantError` | Lists what the repo does contain |
| Disk short | `InsufficientDiskError` | States required vs available |
| Variant conflict | `JobConflictError` | HTTP 409: variant X actively installing for this repo |
| Size / sha mismatch | `IntegrityError` | Deletes `.part`, names expected vs got |
| Smoke test fails all variants | `ModelUnusableError` | Names variants tried + the ORT/crash error |
| User cancel | `AbortError` | Cleans `.part`; no manifest |

Every error carries repo, file, and byte counts. No `catch {}` anywhere.

### 4.5 Security (Rule 04 — SSRF & Path Traversal Posture)

**SSRF Defense:**
- HTTPS only (`parsed.protocol === "https:"`).
- Strict host allowlist with exact/suffix matching:
  `host === "huggingface.co" || host.endsWith(".huggingface.co") || host === "hf.co" || host.endsWith(".hf.co")`.
  Substring matching (`host.includes("hf.co")`) is strictly forbidden to prevent attacker domains like `evil-hf.co` or `hf.co.attacker.net`.
- **Manual redirect following with per-hop re-validation**, capped at 5 hops. Each redirect target URL is parsed and re-validated against the strict host allowlist before fetching.
- Per-file byte cap (4 GB, accommodating large `_data` files).
- No user-supplied URL ever reaches `fetch` — only `repo` as `org/name`, validated against regex `/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/`.

**Path Traversal Defense (Defense-in-Depth):**
HuggingFace repositories are user-controlled, so tree-API filenames are untrusted input.
1. **Strict Role Contract Mapping (§4.1 step 4):** Filenames are mapped by explicit role templates rather than preserved as arbitrary tree subpaths. Basenames matching `".."` or containing path separators are rejected.
2. **Per-file Sanitization:** Every relative destination path must pass `sanitizeSkillFilePath(relPath)` (`config.ts:123-145`), which rejects null bytes (`\0`), backslashes (`\`), absolute prefixes (`/`, `C:`), and parent traversal segments (`..`).
3. **Boundary Assertion:** Before opening any write stream, assert:
   `path.resolve(targetDir, relPath).startsWith(targetDir + path.sep)`.
4. All downloads stream to `<targetPath>.part` inside `<targetDir>` before atomic rename via `fs.rename()`.

### 4.6 The 50 MB gate → 10 MB

`MIN_ONNX_MODEL_SIZE_BYTES` (`embeddings.ts:94`) is lowered to 10 MB. The gate's purpose is
to reject 404 HTML stubs (~1 KB) and truncated files; 10 MB does that. With manifest +
`lfs.oid` + smoke test, installed models carry real verification, so the crude size
heuristic no longer needs to double as a quality filter. This admits quantized MiniLM
(22.9 MB) and other legitimately small models.

### 4.7 Isolation (Rule 06)

All writes go to `data/models/<kind>/<name>/`. Nothing to `$HOME`, nothing to
`~/.cache`. This is why `@huggingface/hub` (which caches to `HF_HOME`, defaulting to
`~/.cache/huggingface`) was ruled out in favour of a hand-rolled client.

---

## 5. UI

### 5.1 `ModelBrowser` (shared dialog)

One component, two consumers (embedding tab, reranker tab) with identical behavior — not a
speculative abstraction.

Three states in one dialog, no navigation:

1. **Search** — `GET /api/models/search?q=&kind=`. Results show id, downloads, size.
2. **Plan preview** — files to download with sizes and roles, the auto-picked variant, the
   resolved pooling mode **and its source** (e.g. `mean (from base model)`), total size, and
   a `▸ choose a different variant` disclosure for the advanced override. Install is
   disabled until the disk check passes.
3. **Progress** — bytes/total, current file, cancel button.

The pooling line is the payoff: the step that used to be a confusing manual guess is stated
before the user commits.

### 5.2 Installed models card

Extends the existing discovery card in both tabs:

```
Xenova--all-MiniLM-L6-v2        int8 · 90 MB · mean        [In use]
  data/models/embedding/Xenova--all-MiniLM-L6-v2/
  [ Remove ]
```

- **Remove** deletes the model directory but **refuses if it is the active selection or a
  session is loaded**, with a message naming the fix.
- Legacy root-level `.onnx` files remain listed, marked `manual`, so the current
  `data/models/embedding/Xenova⁄multilingual-e5-small.onnx` keeps working untouched.
  (Its filename contains U+2044 FRACTION SLASH, an ordinary character to Node — not a path
  separator. Backward compat holds as long as the top-level scan is retained.)

### 5.3 Progress transport

Polling `GET /api/models/install/[jobId]` at ~500 ms. Simpler than SSE, survives a tab
reload, no new infrastructure.

---

## 6. Blast Radius

This change is **not** discovery-only. Files that must change:

| File | Change |
| :--- | :--- |
| `src/lib/memory/embeddings.ts` | Discovery contract (depth + manifest), `MIN_ONNX_MODEL_SIZE_BYTES` 50→10 MB, tier-1 probe dims (`:282`), hardcoded error string (`:1103`) |
| `src/lib/memory/onnx-session.ts` | Widen `OrtSession.run` return type so output `dims` are readable (`:38-44`) |
| `src/lib/memory/reranker.ts` | Point at the real `tokenizer.ts`; discovery via shared store |
| `src/lib/settings.ts` | `saveEmbeddingSettings` currently **drops `poolingMode`** (`:323-338`) — thread it through |
| `src/components/settings/tabs.tsx` | Model browser entry; `filename` is the Select value (`:545,549,555-557`) |
| `src/components/settings-view.tsx` | Re-seed (`:267`), reranker `split('/').pop()` (`:521-522`), persist (`:761`) |
| `src/components/settings/reranker-tab.tsx` | Basename matching (`:140-167`) |
| `src/cli/lib/paths.ts`, `src/cli/types.ts`, `src/cli/commands/install.ts` | Add `embeddingDir` to `InstallPaths` |

**Tests pinning the current contract** (must be updated, not deleted):
`onnx-embedding.test.ts:212-215,279,312,343/347,378-382`,
`onnx-embedding.integration.test.ts:89,97,101`, `tokenizer.test.ts:117-119`,
`pooling.test.ts:25-26,40,62-73`, `reranker.test.ts:308-310,328-329,352-353,360-367`,
`embedding-tab.test.tsx:203-227`, `reranker-tab.test.tsx:14,17-19,76-82`,
`settings-view.test.tsx:91`, `settings-api.test.ts:162`.

### 6.1 Pre-existing bugs fixed in this change

1. **Pooling tier 1 never fires in production.** `embeddings.ts:282` passes a hardcoded 3-D
   `[1,0,0]`; tier 1 requires a 2-D dims array (`pooling.ts:115`). Already-pooled models are
   mis-resolved today. The smoke test needs the real rank anyway.
2. **Selection key is a bare filename.** It is simultaneously the Select value, the
   persisted `modelPath`, and the resolve key — which breaks the moment a model moves into a
   subdirectory. A migration rule is required so a relocated file does not silently degrade
   to `discovered[0]` (`embeddings.ts:228-243`).

---

## 7. Testing

The pure plan is the payoff: no network in unit tests.

| Layer | Tests |
| :--- | :--- |
| `hf-client` | Injected `fetchImpl`; per-hop redirect re-validation; strict suffix allowlist matching (`evil-hf.co` and `hf.co.attacker.net` rejected); timeout; byte cap; `full=true` search |
| `planInstall` | Fake trees: variant ladder, `_data` detection, base-model pooling lookup, missing tokenizer, no-pooling-anywhere, size-gate interaction |
| `download` | Resume from partial `.part`; sha mismatch deletes; atomic rename; abort mid-stream; `ENOSPC` cleanup |
| `store` | Unmanifested directory and orphaned `*.part` sweeping; depth-1 discovery; manifest integrity gating |
| `installer` | Fake client + tmp dir; role contract path derivation; path-traversal rejection on crafted tree filenames; manifest-last ordering |
| `jobs` | Same-variant idempotent join; differing-variant 409 Conflict rejection; disk reservation accounting; abort lifecycle |
| `smoke` | Child process fork isolation: successful IPC dims return; crash signal handling (`SIGSEGV`, `SIGABRT`); timeout escalation; fallback ladder advancement |
| Routes | Job lifecycle, 404 on unknown jobId, 409 on variant conflict, DELETE cancels |
| Integration (gated) | One small model downloaded and smoke-tested for real in isolated child |

**Note:** unit tests mock ORT, so they prove the *wiring*, not that a given variant loads.
Only the gated integration test exercises the real native load. That is why it is not
optional — and it is exactly the class of bug (fp16 abort, missing `tokenizer.json`,
`token_type_ids`) that only a real model has ever caught in this codebase.

Per Rule 18, all runs stay inside the existing bounded-worker config. No concurrent vitest.

---

## 8. Open Questions

1. **Selection key semantics.** Should the persisted key stay a bare display name or become
   the model directory? It is simultaneously the Select value, the persisted registry
   `modelPath`, and the resolve key. Decision required before implementation; §6.1(2)
   assumes a migration rule.
2. **CLI ownership of the embedding dir.** Add `embeddingDir` to `InstallPaths`, or leave
   the embedding directory owned solely by the app?
3. **Verbatim-mirror support.** Commit to flattened-only, or add the tokenizer parent
   fallback later to tolerate unusual repo layouts? Flattened is the decision; the fallback
   is a possible future hardening.
