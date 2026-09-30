// src/lib/llama/resource-planner.ts
import {
  LlamaResourceError,
  DEFAULT_GGUF_PORT,
  MODEL_DEFAULT_CTX,
  GB,
  MB,
  type KvDtype,
  type PlanInput,
  type PlannedServer,
} from "./types";

export const PARAM_RE = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/;
const CTX_FLOOR = 2048;
const VERSION_ARG_RE = /^--?[a-z][a-z0-9-]*$/i;

export function paramsBillions(filename: string): number | null {
  const m = filename.match(PARAM_RE);
  return m ? parseFloat(m[1]) : null;
}

export function estKVPerTokenMB(filename: string, kvDtype: KvDtype): number {
  const params = paramsBillions(filename);
  const base =
    params === null ? 0.6
    : params <= 2 ? 0.1
    : params <= 9 ? 0.3
    : params <= 15 ? 0.5
    : params <= 35 ? 1.0
    : 1.5;
  return kvDtype === "q8_0" ? base / 2 : base;
}

export function usableMemoryBytes(freeMemBytes: number): number {
  const usable = freeMemBytes - Math.max(GB(1.5), Math.floor(freeMemBytes * 0.3));
  if (usable < GB(1.5)) {
    throw new LlamaResourceError(
      "Insufficient free memory for GGUF inference. Close other applications and retry."
    );
  }
  return usable;
}

export function defaultIdleMinutes(modelSizeBytes: number): number {
  return Math.min(15, Math.max(3, Math.round(modelSizeBytes / 1024 ** 3)));
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export function residentOverheadBytes(modelSizeBytes: number): number {
  return Math.floor(modelSizeBytes * 0.3) + MB(512);
}

export function planServerFlags(input: PlanInput): PlannedServer {
  const { filename, modelSizeBytes, modelCtxCap, profile, overrides } = input;
  const usable = usableMemoryBytes(profile.freeMemBytes);
  const overhead = residentOverheadBytes(modelSizeBytes);
  if (overhead > usable) {
    throw new LlamaResourceError(
      `Model file (${formatBytes(modelSizeBytes)}) exceeds estimated usable memory ` +
        `(${formatBytes(usable)}). Try a smaller quantization.`
    );
  }
  const kvBudgetMB = (usable - overhead) / 1024 ** 2;
  const desired = Math.min(
    overrides?.contextWindow ?? MODEL_DEFAULT_CTX,
    modelCtxCap ?? Number.POSITIVE_INFINITY
  );
  const pinned = overrides?.kvDtype && overrides.kvDtype !== "auto" ? overrides.kvDtype : null;
  const unparsedParams = paramsBillions(filename) === null;

  const fits = (ctx: number, dtype: KvDtype): boolean =>
    ctx * estKVPerTokenMB(filename, dtype) <= kvBudgetMB;

  let kvDtype: KvDtype;
  let ctx: number;
  let contextShrunk = false;
  if (pinned) {
    kvDtype = pinned;
    ctx = fits(desired, pinned)
      ? desired
      : Math.floor(kvBudgetMB / estKVPerTokenMB(filename, pinned));
  } else if (fits(desired, "f16")) {
    kvDtype = "f16";
    ctx = desired;
  } else if (fits(desired, "q8_0")) {
    kvDtype = "q8_0";
    ctx = desired;
  } else {
    kvDtype = "q8_0";
    ctx = Math.floor(kvBudgetMB / estKVPerTokenMB(filename, "q8_0"));
    contextShrunk = true;
  }
  if (!pinned && ctx < desired) contextShrunk = true;
  if (ctx < CTX_FLOOR) {
    throw new LlamaResourceError(
      "Even q8_0 KV at minimum context (2048) exceeds memory. Pick a smaller model."
    );
  }

  const threads = clamp(profile.cpuCores - 1, 2, 8);
  const batchSize = clamp(Math.floor(ctx / 8), 256, 1024);
  const ubatchSize = clamp(Math.floor(ctx / 16), 128, 512);
  const ngl = overrides?.ngl ?? 0;
  const idleMinutes = overrides?.idleMinutes ?? defaultIdleMinutes(modelSizeBytes);
  const extraFlags = (overrides?.extraFlags ?? []).filter((f) => VERSION_ARG_RE.test(f));

  const args = [
    "-m", "<model-path>", // replaced with the absolute model path by the runner
    "-c", String(ctx),
    "-t", String(threads),
    "-tb", String(threads),
    "-np", "1",
    "-ngl", String(ngl),
    "-b", String(batchSize),
    "-ub", String(ubatchSize),
    "-ctk", kvDtype,
    "-ctv", kvDtype,
    "--cache-reuse", "256",
    "--jinja",
    "-fa", "on",
    "--host", "127.0.0.1",
    "--port", String(DEFAULT_GGUF_PORT),
    ...extraFlags,
  ];

  const shrinkReason =
    !contextShrunk ? null
    : unparsedParams
      ? `Context shrunk to ${ctx} to fit memory (parameter count for ${filename} could not be determined; using conservative estimate).`
      : `Context shrunk to ${ctx} to fit memory (KV budget ${Math.floor(kvBudgetMB)} MB).`;

  return {
    args, ctx, kvDtype, threads,
    batchSize, ubatchSize, port: DEFAULT_GGUF_PORT,
    contextShrunk, shrinkReason, unparsedParams, idleMinutes,
  };
}

function formatBytes(n: number): string {
  return n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(n / 1024 ** 2)} MB`;
}
