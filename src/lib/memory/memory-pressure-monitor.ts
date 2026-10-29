/**
 * Proactive memory pressure monitor (Rule 07: Never Crash From Resource Exhaustion).
 *
 * A lightweight background task that polls `getAvailableMemoryBytes()` at a
 * conservative interval. When system-available memory drops below the
 * configurable threshold (`YGGDRASIL_MEMORY_PRESSURE_THRESHOLD_MB`,
 * default 256 MB), it proactively releases all loaded ONNX sessions — the
 * single largest reclaimable resource in the process (the reranker model
 * alone can hold 1.5–2 GB of native memory that V8 GC cannot reclaim).
 *
 * This complements the systemd-level protections (OOMScoreAdjust=-1000,
 * MemoryMax cgroup ceiling): instead of relying on the OOM killer to act
 * *after* memory is exhausted, the monitor releases heavyweight models
 * *before* the cgroup or kernel OOM killer has a reason to consider the
 * process.
 *
 * Lifecycle (anchored on globalThis so dev-server HMR reloads do not spawn
 * duplicate timers):
 *   startMemoryPressureMonitor()  → arms the poll loop
 *   stopMemoryPressureMonitor()   → disarms, safe to call multiple times
 *   isMemoryPressureMonitorRunning() → status check
 *
 * The monitor is started by `bootstrapAutonomousCognitiveSystem()` and
 * stopped on SIGTERM/SIGINT alongside the cognitive daemon and queue runner.
 */

import { env } from "@/env";
import { syslog } from "@/lib/observability/log-store";
import { getAvailableMemoryBytes } from "@/lib/system-memory";
import { releaseAllOnnxSessions, isOnnxSessionLoaded } from "./onnx-session";

/** Poll interval — conservative to minimise CPU wake-ups. */
const POLL_INTERVAL_MS = 30_000;

/** Bytes per MB (for threshold comparison). */
const MB = 1024 * 1024;

const MEMORY_MONITOR_GLOBAL_KEY = "__yggdrasilMemoryPressureMonitor";

type MonitorState = {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
};

function monitorGlobal(): MonitorState {
  const g = globalThis as unknown as Record<string, MonitorState | undefined>;
  if (!g[MEMORY_MONITOR_GLOBAL_KEY]) {
    g[MEMORY_MONITOR_GLOBAL_KEY] = { running: false, timer: null };
  }
  return g[MEMORY_MONITOR_GLOBAL_KEY]!;
}

let lastPressureWarningAt = 0;
const PRESSURE_WARN_COOLDOWN_MS = 5 * 60_000; // 5 minutes

/**
 * The effective pressure threshold in bytes, derived from the env var.
 * Read at each poll so `yggdrasil restart` picks up .env changes.
 */
function pressureThresholdBytes(): number {
  return (env.YGGDRASIL_MEMORY_PRESSURE_THRESHOLD_MB ?? 256) * MB;
}

/**
 * Single check iteration: read available memory, and if below the threshold,
 * release all loaded ONNX sessions to return native memory to the OS.
 *
 * Never throws: a failure to read /proc/meminfo or release sessions must not
 * crash the poll loop. Errors are logged and the loop continues.
 */
async function checkMemoryPressure(): Promise<void> {
  let available: number;
  try {
    available = getAvailableMemoryBytes();
  } catch (err) {
    syslog("debug", "memory-pressure", `Failed to read available memory: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const threshold = pressureThresholdBytes();

  if (available >= threshold) {
    return; // Healthy — nothing to do.
  }

  // Memory pressure detected: release ONNX sessions (the largest reclaimable
  // native allocation in the process). Both the reranker and embedding slots
  // are released; the lazy-load pattern means they will be re-acquired on the
  // next request, after memory has been returned to the OS.
  const wasLoaded = isOnnxSessionLoaded("reranker") || isOnnxSessionLoaded("embedding");
  if (wasLoaded) {
    const availableMb = Math.round(available / MB);
    syslog(
      "warn",
      "memory-pressure",
      `Memory pressure: ${availableMb} MB available (threshold: ${threshold / MB} MB). Releasing ONNX sessions.`
    );

    // Rate-limit the warning log.
    const now = Date.now();
    if (now - lastPressureWarningAt > PRESSURE_WARN_COOLDOWN_MS) {
      console.warn(
        `[memory-pressure] Available memory low (${availableMb} MB < ${threshold / MB} MB threshold). ` +
          "Releasing ONNX sessions to prevent OOM."
      );
      lastPressureWarningAt = now;
    }

    try {
      await releaseAllOnnxSessions();
      syslog("info", "memory-pressure", "All ONNX sessions released under memory pressure.");
    } catch (err) {
      syslog("error", "memory-pressure", `Failed to release ONNX sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Start the background memory pressure monitor. Safe to call multiple times:
 * a second call is a no-op when the monitor is already running.
 */
export function startMemoryPressureMonitor(): void {
  const state = monitorGlobal();
  if (state.running) return;
  state.running = true;

  syslog("debug", "memory-pressure", "Memory pressure monitor started.");

  void (async () => {
    do {
      try {
        await checkMemoryPressure();
      } catch (err) {
        syslog("error", "memory-pressure", `Monitor tick error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!monitorGlobal().running) break;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (!monitorGlobal().running) break;
    } while (true);
  })();
}

/**
 * Stop the memory pressure monitor. Safe to call multiple times or when the
 * monitor was never started.
 */
export function stopMemoryPressureMonitor(): void {
  const state = monitorGlobal();
  if (!state.running) return;
  state.running = false;

  syslog("debug", "memory-pressure", "Memory pressure monitor stopped.");
}

/** True when the monitor loop is currently armed. */
export function isMemoryPressureMonitorRunning(): boolean {
  return monitorGlobal().running;
}

/**
 * Test hook: reset the global state so a test can start fresh.
 */
export function resetMemoryPressureMonitorForTest(): void {
  const state = monitorGlobal();
  state.running = false;
  lastPressureWarningAt = 0;
}

/** Test hook: run a single pressure check without starting the loop. */
export async function runMemoryPressureCheckForTest(): Promise<void> {
  await checkMemoryPressure();
}
