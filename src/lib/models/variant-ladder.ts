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
 * Quantization classes, best-first. Index doubles as the rank.
 *
 * The `_int8` / `_quantized` / `_uint8` names come from `transformers.js`
 * conversions; the `_qint8*` / `_quint8*` names come from Optimum exports
 * (`sentence-transformers/*`, `intfloat/*`). Both are the same int8 weight
 * class and load identically on CPU — verified by parsing each graph's
 * initializer dtypes (INT8/UINT8) and running inference on an AVX2-only host.
 *
 * They are separate rungs only to make the *portability* preference explicit:
 * generic names first, then the ubiquitous x86 AVX2 export, then AVX-512, then
 * arm64. That ordering is a soft preference, not a correctness gate — every
 * rung was measured loading and producing correct output regardless of the ISA
 * in its filename, because ORT selects kernels at runtime and the suffix only
 * records which ISA Optimum tuned the export for. Ranking them explicitly
 * matters because the fallback tie-break is `localeCompare`, which would
 * otherwise prefer `_qint8_arm64` on an x86 host.
 */
const QUANT_LADDER = [
  "_int8",
  "_quantized",
  "_uint8",
  "_qint8",
  "_quint8_avx2",
  "_qint8_avx512_vnni",
  "_qint8_avx512",
  "_qint8_arm64",
  "_q4",
  "_q4f16",
  "_bnb4",
] as const;

/**
 * Suffixes that are never auto-picked, regardless of rank.
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

/** Rank of an unquantized (fp32) graph — worse than every quantized class. */
const FP32_RANK = QUANT_LADDER.length;

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
 */
export function variantRank(path: string): number {
  const stem = stemOf(basename(path));
  for (let i = 0; i < QUANT_LADDER.length; i++) {
    if (stem.endsWith(QUANT_LADDER[i])) return i;
  }
  return FP32_RANK;
}

/**
 * All usable ONNX graphs from `paths`, best-first: by quant class, then
 * alphabetically for a stable, deterministic order. fp16 graphs are dropped.
 *
 * Ties are common for multi-graph repos (CLIP-style `text_model_*` /
 * `vision_model_*`), where alphabetical order puts the text tower first — the
 * correct choice for embedding and reranking.
 */
export function rankOnnxVariants(paths: string[]): string[] {
  return paths
    .filter((p) => p.endsWith(".onnx") && !isExcludedVariant(p))
    .sort((a, b) => variantRank(a) - variantRank(b) || a.localeCompare(b));
}

/** Best usable ONNX graph, or `undefined` when none qualify. */
export function pickBestVariant(paths: string[]): string | undefined {
  return rankOnnxVariants(paths)[0];
}
