/**
 * ONNX variant preference ladder — single source of truth for "which variant
 * is best".
 *
 * Both the market (`hf-client.searchModels`) and the installer
 * (`installer.planInstall`) rank variants through this module, so the model the
 * UI advertises as best is the exact file the installer downloads.
 *
 * Matching is **suffix-aware**, not exact-filename: repos such as
 * `jinaai/jina-clip-v1` name their graphs `text_model_int8.onnx` /
 * `vision_model_int8.onnx`. Exact matching silently fails on those and the
 * caller falls back to alphabetical order, which picks `..._bnb4.onnx`
 * (397 MB) over `..._int8.onnx` (118 MB) — or worse, an fp16 graph.
 */

/**
 * Quantization class rungs, best-first. Index doubles as the rank.
 *
 * Per spec §2.4, `_int8` and `_quantized` are the **same QInt8 class** — they
 * form one rung, not two. They are grouped in a single entry; callers that
 * have file sizes prefer the smaller file (spec §4.1: "pick whichever exists,
 * preferring the smaller file when both do").
 *
 * The remaining suffixes come from `transformers.js` conversions (`_uint8`)
 * or Optimum exports (`_qint8*` / `_quint8*`, `sentence-transformers/*`,
 * `intfloat/*`). All load identically on CPU — verified by parsing each
 * graph's initializer dtypes (INT8/UINT8) and running inference on an
 * AVX2-only host. Ordering beyond QInt8 is a soft portability preference,
 * not a correctness gate — ORT selects kernels at runtime and the suffix
 * only records which ISA Optimum tuned the export for.
 */
const QUANT_LADDER: ReadonlyArray<string[]> = [
  ["_int8", "_quantized"], // rank 0 — same QInt8 class (spec §2.4)
  ["_uint8"],              // rank 1 — QUInt8
  ["_qint8"],              // rank 2 — QInt8 (Optimum naming)
  ["_quint8_avx2"],        // rank 3
  ["_qint8_avx512_vnni"],  // rank 4
  ["_qint8_avx512"],       // rank 5
  ["_qint8_arm64"],        // rank 6
];

/**
 * Suffixes that are **never usable on CPU**, regardless of rank or override.
 *
 * - `_fp16`: half-precision weights. The installer design spec §2.4 records a
 *   *native* graph-optimization abort on CPU (a process death, not a catchable
 *   JS error, so a smoke test cannot advance past it) and excludes them
 *   outright. Note: on ORT 1.29 / this x86-64 host an fp16 graph was measured
 *   loading and inferring correctly, so the abort is platform- or
 *   version-dependent — the exclusion is kept as policy because CPU inference
 *   converts to fp32 anyway, so half-precision weights buy nothing here.
 * - `_O4`: Optimum's `_O1.._O4` export ladder, where `_O4` is fp16 — confirmed
 *   by parsing initializer dtypes across several repos (`_O1`/`_O2`/`_O3` are
 *   FLOAT, `_O4` is FLOAT16 at exactly half the file size). It was reachable by
 *   accident because `localeCompare` ignores punctuation, so `model_O4.onnx`
 *   sorted ahead of `model.onnx`, and it outranked a smaller int8 sibling.
 *
 * Consequence: a repo whose *only* graph is excluded becomes uninstallable
 * (`rankOnnxVariants` returns `[]`). That is intentional — offering a
 * half-precision-only model would mean advertising a graph the policy forbids.
 */
const EXCLUDED_SUFFIXES = ["_fp16", "_O4"] as const;

/**
 * Suffixes excluded from **auto-pick** but still selectable via the advanced
 * variant override (spec §4.1).
 *
 * `_q4` / `_q4f16` / `_bnb4` load on ORT ≥ 1.16.2 but are *larger* than int8
 * for embedding models — only MatMul weights are quantized, not the embedding
 * table — so auto-picking them downloads a bigger file for no quality gain.
 * Unlike fp16 they are not broken, so a user who explicitly asks for one must
 * still be able to install it.
 */
const AUTO_PICK_EXCLUDED_SUFFIXES = ["_q4", "_q4f16", "_bnb4"] as const;

/** Rank of an unquantized (fp32) graph — worse than every quantized class. */
const FP32_RANK = QUANT_LADDER.length;

/** Rank of an auto-pick-excluded quant class — worse than fp32, so it sorts last. */
const AUTO_PICK_EXCLUDED_RANK = FP32_RANK + 1;

function basename(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Strip the `.onnx` extension, yielding the variant stem. */
function stemOf(basenameWithExt: string): string {
  return basenameWithExt.endsWith(".onnx")
    ? basenameWithExt.slice(0, -".onnx".length)
    : basenameWithExt;
}

/** True for `*.onnx` files that must never be offered (fp16). */
export function isExcludedVariant(path: string): boolean {
  if (!path.endsWith(".onnx")) return false;
  const stem = stemOf(basename(path));
  return EXCLUDED_SUFFIXES.some((suffix) => stem.endsWith(suffix));
}

/**
 * Preference rank for an ONNX path — lower is better. Quantized classes win
 * over fp32; unknown classes rank just after fp32 so a novel export still
 * appears rather than being dropped.
 *
 * Per spec §2.4, `_int8` and `_quantized` share rank 0 (same QInt8 class).
 *
 * Auto-pick-excluded classes (`_q4`/`_q4f16`/`_bnb4`) rank *after* fp32 so the
 * variant list still offers them (spec §4.1: advanced override only) without
 * ever sorting ahead of a smaller int8 or fp32 graph.
 */
export function variantRank(path: string): number {
  const stem = stemOf(basename(path));
  for (let i = 0; i < QUANT_LADDER.length; i++) {
    if (QUANT_LADDER[i].some((s) => stem.endsWith(s))) return i;
  }
  if (AUTO_PICK_EXCLUDED_SUFFIXES.some((s) => stem.endsWith(s))) {
    return AUTO_PICK_EXCLUDED_RANK;
  }
  return FP32_RANK;
}

/** True when a path may be chosen automatically (not via explicit override). */
function isAutoPickEligible(path: string): boolean {
  if (!path.endsWith(".onnx")) return false;
  if (isExcludedVariant(path)) return false;
  const stem = stemOf(basename(path));
  return !AUTO_PICK_EXCLUDED_SUFFIXES.some((s) => stem.endsWith(s));
}

/**
 * All usable ONNX graphs from `paths`, best-first: by quant class rank, then
 * alphabetically for a stable, deterministic order. fp16 graphs are dropped.
 *
 * This is the *offer* list (market UI + advanced override), so it includes
 * auto-pick-excluded classes like `_q4` — sorted last — while auto-pick
 * functions below filter them out. Ties are common for multi-graph repos
 * (CLIP-style `text_model_*` / `vision_model_*`), where alphabetical order puts
 * the text tower first — the correct choice for embedding and reranking.
 */
export function rankOnnxVariants(paths: string[]): string[] {
  return paths
    .filter((p) => p.endsWith(".onnx") && !isExcludedVariant(p))
    .sort((a, b) => variantRank(a) - variantRank(b) || a.localeCompare(b));
}

/**
 * Best auto-pickable ONNX graph, or `undefined` when none qualify.
 *
 * Spec §4.1: the auto-pick ladder is `int8|quantized → uint8 → fp32`;
 * `q4`/`q4f16`/`bnb4` are excluded from auto-pick (available via the advanced
 * override only), so a repo whose *only* graph is one of those returns
 * `undefined` here and must be installed through an explicit variant choice.
 */
export function pickBestVariant(paths: string[]): string | undefined {
  return paths
    .filter(isAutoPickEligible)
    .sort((a, b) => variantRank(a) - variantRank(b) || a.localeCompare(b))[0];
}

/**
 * Best auto-pickable variant with file-size awareness: when two paths share the
 * same quant rank (e.g. `_int8` vs `_quantized`, both rank 0), prefers the
 * smaller file (spec §4.1: "pick whichever exists, preferring the smaller file
 * when both do").
 */
export function pickBestVariantWithSizes(
  variants: Array<{ path: string; sizeBytes?: number }>,
): string | undefined {
  const ranked = variants
    .filter((v) => isAutoPickEligible(v.path))
    .sort(
      (a, b) =>
        variantRank(a.path) - variantRank(b.path) ||
        (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
        a.path.localeCompare(b.path),
    );
  return ranked[0]?.path;
}

/**
 * CPU fallback ladder: ordered list of variant paths for sequential
 * retry-on-failure. Per spec §4.1/§4.3 the ladder is exactly the canonical
 * three rungs — `int8|quantized` → `uint8` → `fp32` — so `fp32` (the most
 * compatible, unquantized variant) is always tried before declaring a model
 * unusable. Auto-pick-excluded and fp16 classes are never included.
 *
 * Variants within the same quant class are ordered smallest-first (spec §4.1).
 * At most three paths are returned.
 */
export function cpuFallbackLadder(
  variants: Array<{ path: string; sizeBytes?: number }>,
): string[] {
  const bySizeThenPath = (
    a: { path: string; sizeBytes?: number },
    b: { path: string; sizeBytes?: number },
  ) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0) || a.path.localeCompare(b.path);

  const eligible = variants.filter((v) => isAutoPickEligible(v.path));
  const bestOfRank = (rank: number): string | undefined =>
    eligible.filter((v) => variantRank(v.path) === rank).sort(bySizeThenPath)[0]?.path;

  // Canonical rungs: QInt8 → QUInt8 → fp32. Absent rungs are skipped.
  const ladder = [bestOfRank(0), bestOfRank(1), bestOfRank(FP32_RANK)];
  return ladder.filter((p): p is string => p !== undefined);
}
