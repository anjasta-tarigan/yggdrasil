import fs from "node:fs";
import path from "node:path";
import { syslog } from "@/lib/observability/log-store";

/**
 * Pooling resolution for local ONNX sentence embedders.
 *
 * The problem: an ONNX embedder that outputs `last_hidden_state` gives one
 * vector per TOKEN, not per sentence. Collapsing those rows into a single
 * sentence vector is a training-time choice that is NOT recorded in the ONNX
 * graph — BGE uses CLS pooling, MiniLM uses mean pooling, and both export an
 * identical `[1, seq, hidden]` output signature. Feeding a model the wrong
 * pooling yields a valid-looking vector from the wrong region of embedding
 * space: retrieval degrades silently, with no error to catch.
 *
 * Behavioural detection does not work. Measured on real models, mean pooling
 * scored a LARGER related-vs-unrelated margin than CLS for a CLS-trained model
 * (0.457 vs 0.418), and for a mean-trained model (0.519 vs 0.244). The margin
 * heuristic picks "mean" for both, so it cannot be trusted.
 *
 * Resolution is therefore tiered, and only the last tier asks the user:
 *   1. The graph output shape — a 2-D `[1, hidden]` output is already pooled
 *      (sentence_transformers*.onnx exports, jina's -mean-pooling variant).
 *   2. A sidecar config — `1_Pooling/config.json` beside the model or one
 *      level up (the sentence-transformers layout puts it at the repo root
 *      while the ONNX sits in onnx/).
 *   3. Unresolved → the caller prompts, and the choice is persisted.
 */

export type PoolingMode = "mean" | "cls" | "lasttoken" | "max";

export type PoolingResolution =
  /** The graph already emits one vector per input — no pooling to apply. */
  | { kind: "already-pooled" }
  /** Resolved without user input. */
  | { kind: "resolved"; mode: PoolingMode; source: "sidecar" | "modules" }
  /** Nothing declared it; the caller must ask and persist a choice. */
  | { kind: "unresolved"; searched: string[] };

/** Config key → mode. Order matters only for deterministic reporting. */
const POOLING_KEYS: ReadonlyArray<readonly [string, PoolingMode]> = [
  ["pooling_mode_cls_token", "cls"],
  ["pooling_mode_mean_tokens", "mean"],
  ["pooling_mode_lasttoken", "lasttoken"],
  ["pooling_mode_max_tokens", "max"],
];

/**
 * Read a sentence-transformers pooling config. Returns the mode when exactly
 * one `pooling_mode_*` flag is true.
 *
 * Returns null when the file is missing/unreadable, when no flag is set, or
 * when SEVERAL are set — a multi-mode config concatenates its pooled vectors
 * (dimension = hidden × modes), which is a different output shape than any
 * single mode produces, so it must not be silently collapsed to one.
 */
function readPoolingConfig(filePath: string): PoolingMode | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ filePath, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const config = raw as Record<string, unknown>;

  const active = POOLING_KEYS.filter(([key]) => config[key] === true);
  if (active.length !== 1) return null;
  return active[0][1];
}

/**
 * Follow `modules.json` to the Pooling module's directory, then read its
 * config. The path is repo-relative (e.g. "1_Pooling").
 */
function readPoolingViaModules(rootDir: string): PoolingMode | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(rootDir, "modules.json"), "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const entryModule = entry as Record<string, unknown>;
    if (
      typeof entryModule.type !== "string" ||
      !entryModule.type.includes("Pooling")
    ) {
      continue;
    }
    if (typeof entryModule.path !== "string" || entryModule.path.length === 0) {
      continue;
    }
    const mode = readPoolingConfig(
      path.join(rootDir, entryModule.path, "config.json")
    );
    if (mode) return mode;
  }
  return null;
}

/**
 * Locate the pooling mode for `modelPath` given the graph's output dims.
 *
 * @param outputDims The first output tensor's dims, e.g. [1, 7, 384] or [1, 384].
 */
export function resolvePoolingMode(
  modelPath: string,
  outputDims: readonly number[]
): PoolingResolution {
  // Tier 1: a 2-D output is [batch, hidden] — the graph pooled internally.
  if (outputDims.length === 2) return { kind: "already-pooled" };

  // Tier 2: sidecar config. The ONNX usually lives in `onnx/` while the
  // sentence-transformers config sits at the repo root, so check both the
  // model's own directory and its parent.
  const modelDir = path.dirname(modelPath);
  const roots = [modelDir, path.dirname(modelDir)];
  const searched: string[] = [];

  for (const root of roots) {
    const direct = path.join(root, "1_Pooling", "config.json");
    searched.push(direct);
    const mode = readPoolingConfig(direct);
    if (mode) return { kind: "resolved", mode, source: "sidecar" };

    const viaModules = readPoolingViaModules(root);
    if (viaModules) {
      return { kind: "resolved", mode: viaModules, source: "modules" };
    }
    searched.push(path.join(root, "modules.json"));
  }

  // Tier 3: nothing declared it — the caller must ask.
  syslog(
    "info",
    "embeddings",
    `ONNX model declares no pooling mode; user selection required (${path.basename(modelPath)})`
  );
  return { kind: "unresolved", searched };
}

/**
 * Pool a token-level embedding matrix into one sentence vector.
 *
 * @param flat  Row-major `[seqLen, hidden]` data from the output tensor.
 * @param attentionMask Per-token 1/0 mask; 0 rows are excluded from mean/max.
 */
export function poolTokenEmbeddings(
  flat: Float32Array,
  seqLen: number,
  hidden: number,
  attentionMask: readonly number[],
  mode: PoolingMode
): Float32Array {
  const out = new Float32Array(hidden);
  const row = (j: number) => j * hidden;

  switch (mode) {
    case "cls": {
      // First token ([CLS]).
      out.set(flat.subarray(0, hidden));
      return out;
    }
    case "lasttoken": {
      // Last non-masked token; falls back to the final row.
      let last = seqLen - 1;
      for (let j = seqLen - 1; j >= 0; j--) {
        if (attentionMask[j] !== 0) {
          last = j;
          break;
        }
      }
      out.set(flat.subarray(row(last), row(last) + hidden));
      return out;
    }
    case "max": {
      out.fill(-Infinity);
      for (let j = 0; j < seqLen; j++) {
        if (attentionMask[j] === 0) continue;
        const base = row(j);
        for (let i = 0; i < hidden; i++) {
          const v = flat[base + i];
          if (v > out[i]) out[i] = v;
        }
      }
      // All-masked input: leave zeros rather than -Infinity.
      for (let i = 0; i < hidden; i++) {
        if (!Number.isFinite(out[i])) out[i] = 0;
      }
      return out;
    }
    case "mean":
    default: {
      let count = 0;
      for (let j = 0; j < seqLen; j++) {
        if (attentionMask[j] === 0) continue;
        const base = row(j);
        for (let i = 0; i < hidden; i++) out[i] += flat[base + i];
        count += 1;
      }
      if (count > 0) {
        for (let i = 0; i < hidden; i++) out[i] /= count;
      }
      return out;
    }
  }
}
