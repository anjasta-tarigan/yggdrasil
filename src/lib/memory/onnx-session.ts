/**
 * Shared ONNX Runtime session lifecycle for on-device models.
 *
 * Both the reranker and the ONNX embedding provider need the same pattern:
 * load an InferenceSession once, reuse it across calls, release it after
 * an idle timeout (V8 GC cannot reclaim native ORT memory), and deduplicate
 * concurrent initialization. This module extracts that lifecycle so both
 * consumers share one implementation.
 *
 * One session per SLOT, each with its own idle timer. A slot is a named
 * consumer ("reranker", "embedding"); it holds at most one model at a time,
 * so switching a slot's model releases the old session before loading the
 * new one. Slots are independent and may be live simultaneously — a memory
 * search embeds the query and then reranks the candidates, so evicting one
 * to load the other would reload a multi-hundred-MB model on every search.
 *
 * Peak RSS = reranker (≈1.5–2 GB) + embedder (≈100–500 MB) while the
 * retrieval path is warm; both return to zero after their idle timeouts.
 */

import os from "node:os";
import { syslog } from "@/lib/observability/log-store";

// ── Optional ORT type surface (duck-typed so the module compiles without the
//    native package installed — the provider is simply disabled). ─────────────

export interface OrtTensor {
  type: string;
  data: unknown;
  dims: readonly number[];
}

export interface OrtSession {
  /** Names of the graph's declared inputs (e.g. token_type_ids is optional). */
  readonly inputNames: readonly string[];
  /** Names of the graph's declared outputs. */
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<{
    logits?: { data: Float32Array; dims?: readonly number[] };
    last_hidden_state?: { data: Float32Array; dims?: readonly number[] };
    sentence_embedding?: { data: Float32Array; dims?: readonly number[] };
    output?: { data: Float32Array; dims?: readonly number[] };
    [key: string]: unknown;
  }>;
  release(): Promise<void>;
}

export interface OrtModule {
  InferenceSession: {
    create(
      path: string,
      options?: Record<string, unknown>
    ): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: unknown,
    dims: readonly number[]
  ) => OrtTensor;
}

export type OrtLoader = () => Promise<OrtModule>;

let customOrtLoader: OrtLoader | null = null;

/** Test hook: override the dynamic ORT module loader in unit tests. */
export function setOrtLoaderForTest(loader: OrtLoader | null): void {
  customOrtLoader = loader;
}

/**
 * Dynamically import onnxruntime-node. The variable-based import specifier
 * hides it from Vite/Rollup's static resolver so the module bundles cleanly
 * even when the optional native package is absent.
 */
export async function loadOrt(): Promise<OrtModule> {
  if (customOrtLoader) {
    return customOrtLoader();
  }
  try {
    const pkg = "onnxruntime-node";
    const mod = await import(/* @vite-ignore */ pkg);
    return (mod.default ?? mod) as unknown as OrtModule;
  } catch {
    throw new Error(
      "onnxruntime-node is not installed. Run: pnpm add onnxruntime-node"
    );
  }
}

/**
 * malloc_trim(0) on Linux nudges glibc to return free arenas to the OS.
 * Pure JS cannot invoke it directly without FFI; if a native helper is
 * present via global.gc() it is called by the consumer.
 */
export function mallocTrim(): void {
  // Best-effort no-op in pure-JS; consumers that loaded ORT can call gc().
}

/** Named consumer slot. Each slot holds at most one loaded model. */
export const ONNX_SLOT_RERANKER = "reranker";
export const ONNX_SLOT_EMBEDDING = "embedding";

export type SessionEntry = {
  session: OrtSession;
  timer: ReturnType<typeof setTimeout> | null;
  modelPath: string;
  /** Idle timeout (ms) before auto-release for this slot. */
  idleTimeoutMs: number;
};

export type SessionRegistry = Record<string, SessionEntry>;

/** Anchored on globalThis so Next.js HMR reloads find the live sessions. */
export const ONNX_SESSION_GLOBAL_KEY = "__yggdrasilOnnxSessions";

export function onnxSessionsGlobal(): SessionRegistry {
  const g = globalThis as unknown as Record<string, SessionRegistry | undefined>;
  if (!g[ONNX_SESSION_GLOBAL_KEY]) {
    g[ONNX_SESSION_GLOBAL_KEY] = {};
  }
  return g[ONNX_SESSION_GLOBAL_KEY]!;
}

/** In-flight initializations, keyed by slot (dedupes concurrent acquires). */
const initPromises = new Map<string, Promise<OrtSession>>();
const slotLocks = new Map<string, Promise<unknown>>();

/**
 * Acquire (or reuse) the session for `slot`.
 *
 * - Same modelPath already loaded → reuse it and reset its idle timer.
 * - Different modelPath → release the slot's old session, then load.
 * - Concurrent acquires for the same slot share one in-flight promise.
 *
 * Other slots are untouched, so the reranker and embedder can both be live.
 */
export async function acquireOnnxSession(
  slot: string,
  modelPath: string,
  createOptions?: Record<string, unknown>,
  idleTimeoutMs: number = 120_000
): Promise<OrtSession> {
  const registry = onnxSessionsGlobal();
  const existing = registry[slot];

  // Fast path: if already loaded with the requested model, return immediately
  if (existing && existing.modelPath === modelPath) {
    if (existing.timer !== null) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    scheduleOnnxRelease(slot, idleTimeoutMs);
    return existing.session;
  }

  // Deduplicate concurrent in-flight initialization for the same slot
  const existingInit = initPromises.get(slot);
  if (existingInit) {
    return existingInit;
  }

  // Serialize acquisition per slot so model releases and creations do not interleave
  const prevLock = slotLocks.get(slot) ?? Promise.resolve();
  let releaseLock: () => void;
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  slotLocks.set(slot, currentLock);

  const initPromise = (async () => {
    try {
      await prevLock;

      // Re-check after obtaining lock
      const currentExisting = registry[slot];
      if (currentExisting) {
        if (currentExisting.modelPath === modelPath) {
          if (currentExisting.timer !== null) {
            clearTimeout(currentExisting.timer);
            currentExisting.timer = null;
          }
          scheduleOnnxRelease(slot, idleTimeoutMs);
          return currentExisting.session;
        }
        await releaseOnnxSession(slot);
      }

      const ort = await loadOrt();
      syslog("info", "onnx", `Loading ONNX session (${slot}) from ${modelPath}`);

      const opts: Record<string, unknown> = {
        // Prevent glibc arena growth so memory returns to the OS (ort#25325).
        enableCpuMemArena: false,
        // Pattern-based pre-allocation creates residual memory pressure.
        enableMemPattern: false,
        executionMode: "sequential" as const,
        graphOptimizationLevel: "all" as const,
        intraOpNumThreads: Math.min(os.cpus().length, 4),
        interOpNumThreads: 1,
        // Load from file path: streaming parse peaks at 2× model size, vs 3×
        // for Uint8Array loading. File path is preferred for production.
        executionProviders: ["cpu"],
        ...createOptions,
      };

      const session = await ort.InferenceSession.create(modelPath, opts);

      registry[slot] = {
        session,
        timer: null,
        modelPath,
        idleTimeoutMs,
      };
      scheduleOnnxRelease(slot, idleTimeoutMs);
      syslog("info", "onnx", `ONNX session ready (${slot}): ${modelPath}`);
      return session;
    } finally {
      initPromises.delete(slot);
      releaseLock!();
    }
  })();

  initPromises.set(slot, initPromise);
  return initPromise;
}

function scheduleOnnxRelease(slot: string, idleTimeoutMs: number): void {
  const registry = onnxSessionsGlobal();
  const entry = registry[slot];
  if (!entry) return;
  entry.idleTimeoutMs = idleTimeoutMs;
  entry.timer = setTimeout(() => {
    void releaseOnnxSession(slot);
  }, idleTimeoutMs);
  if (typeof entry.timer.unref === "function") {
    entry.timer.unref();
  }
}

/**
 * Release the session held by `slot` (if any). Called on idle timeout, model
 * switch, or config change. No-op when the slot is empty.
 */
export async function releaseOnnxSession(slot: string): Promise<void> {
  const registry = onnxSessionsGlobal();
  const entry = registry[slot];
  if (!entry) return;
  delete registry[slot];
  if (entry.timer !== null) clearTimeout(entry.timer);

  try {
    await entry.session.release();
    // V8 GC cannot reclaim native ORT memory — nudge it explicitly.
    if (typeof global.gc === "function") global.gc();
    mallocTrim();
    syslog("info", "onnx", `ONNX session released (${slot})`);
  } catch (err) {
    syslog(
      "error",
      "onnx",
      `session.release() failed (${slot}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** True when `slot` currently holds a loaded session. */
export function isOnnxSessionLoaded(slot: string): boolean {
  return slot in onnxSessionsGlobal();
}

/** Release every loaded ONNX session (config change / graceful shutdown). */
export async function releaseAllOnnxSessions(): Promise<void> {
  const registry = onnxSessionsGlobal();
  await Promise.all(Object.keys(registry).map((slot) => releaseOnnxSession(slot)));
}
