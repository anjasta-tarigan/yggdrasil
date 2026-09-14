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
| `hf-client.ts` | `searchModels`, `getModelTree`, `getModelInfo`. Host allowlist, **manual per-hop redirect re-validation**, timeouts, byte caps. | impure (network) |
| `download.ts` | One file: stream → `.part`, Range-resume, size + `lfs.oid` verification, atomic rename. | impure (disk) |
| `installer.ts` | `planInstall()` — decide *what* to fetch. `executeInstall()` — drive downloads, smoke test, manifest, progress. | **plan is pure** (client injected) |
| `store.ts` | Layout, manifest read/write, `discoverModels(kind)`. | impure (disk) |
| `smoke.ts` | Throwaway ORT session: create → run probe → read real output dims → release. | impure (native) |
| `jobs.ts` | In-memory job registry (globalThis-anchored, HMR-safe like `onnx-session.ts`), abort, progress snapshots. | stateful |

```
src/lib/models/
  hf-client.ts  download.ts  installer.ts  store.ts  smoke.ts  jobs.ts
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
- **fp16 is excluded** from the CPU ladder (native abort — see §2.4).
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

**4. Layout.** Flattened per §2.2. All sidecars co-located with the graph, at depth 1.

**5. Estimated total size**, for the pre-install disk check and the UI.

### 4.2 `executeInstall(job, plan)`

Per file: stream to `<target>.part` → verify byte size against the tree's `lfs.size` →
verify sha256 against `lfs.oid` → atomic rename. **The manifest is written last and is the
completion marker** — discovery requires a valid manifest, so a half-finished install can
never appear in the dropdown.

**Idempotency (Rule 17):** jobs keyed by `kind:repo`; a second install of the same repo
joins the in-flight job rather than starting a parallel one.

**Disk pre-check:** compare the plan total against available space and refuse with a
specific message before any bytes are transferred.

### 4.3 Smoke test (`smoke.ts`) — the correctness gate

After download, load the model in a **throwaway** ORT session and run one dummy inference.
This is not optional; it is the only way to know the variant actually loads.

```ts
// Direct module use — NOT acquireOnnxSession.
const ort = await loadOrt();
const session = await ort.InferenceSession.create(path, {
  executionProviders: ["cpu"],
  enableCpuMemArena: false,
  enableMemPattern: false,
  executionMode: "sequential",
});
try {
  const out = await session.run(probeFeeds(session.inputNames));   // MUST run, not just create
  const dims = readOutputDims(out);                                 // real rank, cast
  pooling = resolvePoolingMode(path, dims);
} finally {
  await session.release();
}
```

Three constraints that a naïve implementation gets wrong:

- **Use `InferenceSession.create` directly.** Calling `acquireOnnxSession` with a synthetic
  slot would pollute the process-global registry (`globalThis.__yggdrasilOnnxSessions`,
  `onnx-session.ts:115-123`), be swept by `releaseAllOnnxSessions` (`onnx-session.ts:251-254`),
  and arm a stray idle timer.
- **It must `run()`, not merely `create()`.** fp16 (and other unsupported-op cases) fail
  during graph optimization / first run, not at create.
- **It must read the real output tensor dims.** `OrtSession.run`'s declared return type
  erases `dims` (`onnx-session.ts:38-44`), so a cast is required. This matters because the
  production probe at `embeddings.ts:282` passes a hardcoded 3-D `[1,0,0]` and therefore
  **never triggers pooling tier 1** — already-pooled models are mis-resolved today.

**Fallback ladder:** on smoke-test failure, advance to the next variant automatically, up to
two attempts. A native abort (process exit) is **non-retryable** and must not loop. Because
each rung can cost 100–470 MB, the ladder is ordered by size and the UI states the variant
being attempted.

**Cost:** ~2–5 s for an int8 model. Paid once, at install.

### 4.4 Errors (typed; Rule 02 — no silent fallbacks)

| Condition | Error | Behavior |
| :--- | :--- | :--- |
| HF unreachable / timeout | `HfUnreachableError` | Retryable; names the host |
| Repo not found / private | `HfRepoNotFoundError` | "check the spelling, or it may be private" |
| No `.onnx` in repo | `NoOnnxVariantError` | Lists what the repo does contain |
| Disk short | `InsufficientDiskError` | States required vs available |
| Size / sha mismatch | `IntegrityError` | Deletes `.part`, names expected vs got |
| Smoke test fails all variants | `ModelUnusableError` | Names variants tried + the ORT error |
| User cancel | `AbortError` | Cleans `.part`; no manifest |

Every error carries repo, file, and byte counts. No `catch {}` anywhere.

### 4.5 Security (Rule 04 — SSRF posture)

- HTTPS only; host allowlist `{huggingface.co, *.hf.co, *.huggingface.co}`.
- **Manual redirect following with per-hop re-validation**, capped at 5 hops, because the
  302 target is a *different* host while the 307 target is same-host. This is precisely what
  `guardedFetch` cannot do.
- Per-file byte cap (4 GB, for `_data` files).
- Path-traversal guard on every written path (same discipline as the plugin installer's
  `sanitizeSkillFilePath`).
- No user-supplied URL ever reaches `fetch` — only `repo` as `org/name`, validated against a
  strict regex.

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
| `hf-client` | Injected `fetchImpl`; per-hop redirect re-validation; allowlist rejection; timeout; byte cap; `full=true` search |
| `planInstall` | Fake trees: variant ladder, `_data` detection, base-model pooling lookup, missing tokenizer, no-pooling-anywhere, size-gate interaction |
| `download` | Resume from partial `.part`; sha mismatch deletes; atomic rename; abort mid-stream |
| `installer` | Fake client + tmp dir; manifest-last ordering; idempotent double-install joins one job |
| `smoke` | Mocked ORT: run-vs-create, dims extraction, release in `finally`, non-retryable abort |
| Routes | Job lifecycle, 404 on unknown jobId, DELETE cancels |
| Integration (gated) | One small model downloaded and smoke-tested for real |

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
