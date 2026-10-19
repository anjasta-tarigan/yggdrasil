import os from "node:os";
import fs from "node:fs";
import { syslog } from "@/lib/observability/log-store";

/**
 * Lightweight, dependency-free system memory probe.
 *
 * Extracted from `system-stats.ts` so that client components (and other
 * modules that must not bundle `onnxruntime-node` or DB layers) can safely
 * call this without pulling in the full statistics import graph.
 *
 * On Linux, /proc/meminfo's MemAvailable represents the kernel's estimate of
 * memory actually available for starting new applications without swapping
 * (including reclaimable caches and buffers). os.freemem() on Linux merely
 * exposes raw unallocated pages (sysinfo.freeram), making systems look
 * deceptively out of memory.
 *
 * On Windows, macOS, or environments where /proc/meminfo is inaccessible,
 * gracefully falls back to os.freemem().
 */
export function getAvailableMemoryBytes(): number {
  if (process.platform === "linux") {
    try {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (match && match[1]) {
        return Number.parseInt(match[1], 10) * 1024;
      }
    } catch (err) {
      syslog("debug", "system-memory", `Error: ${err instanceof Error ? err.message : String(err)}`);
      // Fallback below
    }
  }
  return os.freemem();
}
