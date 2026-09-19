import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { databasePath, db as defaultDb, type AppDatabase } from "@/db";
import { getDatabaseStats, type DatabaseStats } from "./database-service";
import { getCronSchedules, isCognitiveDaemonRunning } from "./daemon/scheduler";
import { isQueueRunnerRunning } from "./queue/runner";
import { getEmbeddingConfigFromRegistry, getOnnxEmbeddingStatus } from "./memory/embeddings";
import { getRerankerStatus } from "./memory/reranker";
import { resolveModelName } from "@/lib/health/service-status";
import { discoverModels } from "@/lib/models/store";
import { loadRegistry, resolveApiKey } from "@/lib/ai/provider-config/store";
import { syslog } from "@/lib/observability/log-store";

/**
 * System statistics for the Statistics page: device facts, live resource
 * usage, optional GPU probe, service endpoints, cognitive-loop summary
 * and the maintenance schedule. Everything here is cheap and read-only;
 * the UI polls the resource-heavy parts every few seconds.
 */

export interface GpuStats {
  name: string;
  memoryUsedMb: number;
  memoryTotalMb: number;
  utilizationPercent: number;
}

export interface SystemStats {
  collectedAt: string;
  device: {
    hostname: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    cpuCores: number;
    nodeVersion: string;
    nextVersion: string | null;
    processUptimeSeconds: number;
  };
  resources: {
    loadAverage: [number, number, number];
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    memoryAvailableBytes: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
    processHeapTotalBytes: number;
    diskTotalBytes: number;
    diskFreeBytes: number;
    databaseSizeBytes: number;
  };
  /** Present only when an NVIDIA GPU is visible via nvidia-smi. */
  gpu: GpuStats | null;
  services: {
    llm: {
      baseUrl: string | null;
      modelId: string | null;
      status: "ok" | "down" | "unconfigured";
      latencyMs: number | null;
    };
    embedding: {
      provider: string;
      baseUrl: string | null;
      model: string | null;
      /** Present for provider "onnx": whether the native session is loaded. */
      loaded?: boolean;
      /** Present for provider "onnx": the resolved model file path. */
      modelPath?: string | null;
    };
    reranker: {
      enabled: boolean;
      status: "active" | "standby" | "fallback" | "disabled";
      model: string | null;
      loaded: boolean;
      modelPath: string | null;
      sizeBytes?: number;
    };
  };
  scheduler: {
    daemonRunning: boolean;
    queueRunnerRunning: boolean;
    cron: Record<string, string>;
  };
  database: DatabaseStats;
}

// Runtime-invariant probes are cached at module scope: the Statistics view
// polls every 5s, and re-reading package.json or re-spawning nvidia-smi
// (2.5s timeout, failing on every non-GPU host) per poll is pure waste.
let cachedNextVersion: string | null | undefined;

function readNextVersion(): string | null {
  if (cachedNextVersion !== undefined) return cachedNextVersion;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    cachedNextVersion = pkg.dependencies?.next ?? null;
  } catch (err) {
    syslog("debug", "system-stats", `Error: ${err instanceof Error ? err.message : String(err)}`);
    cachedNextVersion = null;
  }
  return cachedNextVersion;
}

/** null = probed and absent (nvidia-smi missing) — do not respawn forever. */
let gpuAbsent: boolean | undefined;
let lastGpuStats: GpuStats | null = null;
let lastGpuProbeAt = 0;
const GPU_PROBE_COOLDOWN_MS = 30_000;

/**
 * Cross-platform available memory calculator:
 * On Linux, /proc/meminfo's MemAvailable represents the kernel's estimate of
 * memory actually available for starting new applications without swapping
 * (including reclaimable caches and buffers). os.freemem() on Linux merely
 * exposes raw unallocated pages (sysinfo.freeram), making systems look
 * deceptively out of memory (often 90%+ used) even when mostly idle.
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
      syslog("debug", "system-stats", `Error: ${err instanceof Error ? err.message : String(err)}`);
      // Fallback below
    }
  }
  return os.freemem();
}

async function probeGpu(): Promise<GpuStats | null> {
  // nvidia-smi absent (ENOENT): cache the negative result so a non-GPU
  // host does not spawn a failing 2.5s child process on every 5s poll.
  if (gpuAbsent) return null;
  // Live GPU hosts still refresh numbers, but no faster than the cooldown.
  const now = Date.now();
  if (lastGpuStats && now - lastGpuProbeAt < GPU_PROBE_COOLDOWN_MS) {
    return lastGpuStats;
  }

  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.used,memory.total,utilization.gpu",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 2500 },
      (error, stdout) => {
        if (error) {
          // ENOENT (no binary) is permanent on this host; other failures
          // (transient) keep retrying on later polls.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            gpuAbsent = true;
          }
          resolve(null);
          return;
        }
        const line = stdout.trim().split("\n")[0];
        const [name, memUsed, memTotal, util] = (line ?? "").split(",").map((s) => s?.trim());
        if (!name) {
          resolve(null);
          return;
        }
        const stats: GpuStats = {
          name,
          memoryUsedMb: Number(memUsed) || 0,
          memoryTotalMb: Number(memTotal) || 0,
          utilizationPercent: Number(util) || 0,
        };
        lastGpuStats = stats;
        lastGpuProbeAt = now;
        resolve(stats);
      }
    );
  });
}

async function probeLlmEndpoint(): Promise<SystemStats["services"]["llm"]> {
  // Registry-backed: probe the "server" provider, else the first entry.
  // A missing/corrupt registry must degrade to "unconfigured", not throw —
  // the Statistics page polls this every few seconds.
  let baseUrl: string | null = null;
  let apiKey: string | undefined;
  let modelId: string | null = null;
  try {
    const doc = await loadRegistry();
    const entry =
      doc.providers.find((p) => p.id === "server") ?? doc.providers[0];
    if (!entry) {
      return { baseUrl: null, modelId: null, status: "unconfigured", latencyMs: null };
    }
    baseUrl = entry.baseUrl;
    apiKey = await resolveApiKey(entry);
    // Doc-wide isDefault model, else the first model of that provider.
    const flagged = doc.providers.flatMap((p) =>
      p.models.filter((m) => m.isDefault)
    );
    modelId =
      flagged[0]?.modelId ?? entry.models[0]?.modelId ?? null;
    if (!baseUrl) {
      return { baseUrl, modelId, status: "unconfigured", latencyMs: null };
    }
  } catch (err) {
    syslog("debug", "stats", `probeLlmEndpoint: loadRegistry failed: ${err instanceof Error ? err.message : String(err)}`);
    return { baseUrl: null, modelId: null, status: "unconfigured", latencyMs: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const startedAt = performance.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    return {
      baseUrl,
      modelId,
      status: res.ok ? "ok" : "down",
      latencyMs,
    };
  } catch (err) {
    syslog("debug", "stats", `probeLlmEndpoint: fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return { baseUrl, modelId, status: "down", latencyMs: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectSystemStats(
  options: { db?: AppDatabase } = {}
): Promise<SystemStats> {
  const db = options.db ?? defaultDb;
  const cpus = os.cpus();
  const mem = process.memoryUsage();

  let diskTotalBytes = 0;
  let diskFreeBytes = 0;
  try {
    const stats = fs.statfsSync(path.dirname(databasePath));
    diskTotalBytes = stats.blocks * stats.bsize;
    diskFreeBytes = stats.bavail * stats.bsize;
  } catch (err) {
    // statfs unsupported on this platform — report zeros.
    syslog("debug", "stats", `statfs failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let databaseSizeBytes = 0;
  try {
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (fs.existsSync(/* turbopackIgnore: true */ file)) {
        databaseSizeBytes += fs.statSync(/* turbopackIgnore: true */ file).size;
      }
    }
  } catch (err) {
    // DB file missing — report zero.
    syslog("debug", "stats", `statSync db files failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const [gpu, llm] = await Promise.all([probeGpu(), probeLlmEndpoint()]);

  let embedding: SystemStats["services"]["embedding"] = {
    provider: "server",
    baseUrl: null,
    model: null,
  };
  try {
    // Registry-backed: the legacy SQLite `embedding` key was deleted by
    // the provider-config migration, so the deprecated getter would
    // always report the defaults.
    const emb = await getEmbeddingConfigFromRegistry();
    const isOnnx = emb.provider === "onnx";
    const onnxStatus =
      isOnnx && emb.modelPath
        ? await getOnnxEmbeddingStatus(emb.modelPath)
        : null;
    embedding = {
      provider: emb.provider ?? "server",
      baseUrl: emb.baseUrl ?? null,
      // ONNX models are file-based: the display name is derived from the
      // on-disk file (repo leaf / filename stem). We must NOT use `emb.model`
      // for ONNX — that field is never written by the ONNX settings save
      // (which omits `model`, and JSON drops `undefined`), so it lingers as a
      // stale leftover from the prior provider (e.g. an OpenRouter model id).
      // Surfacing it would make the Statistics view report "another
      // provider's" embedding model, exactly the footer bug being fixed.
      model: isOnnx
        ? resolveModelName(
            undefined,
            onnxStatus?.modelPath ?? emb.modelPath ?? null,
            discoverModels("embedding")
          )
        : (emb.model ?? null),
      ...(isOnnx
        ? {
            modelPath: emb.modelPath ?? null,
            loaded: onnxStatus?.loaded ?? false,
          }
        : {}),
    };
  } catch (err) {
    // Registry missing/corrupt — keep defaults (stats never throw).
    syslog("debug", "stats", `embedding stats resolution failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let reranker: SystemStats["services"]["reranker"] = {
    enabled: false,
    status: "disabled",
    model: null,
    loaded: false,
    modelPath: null,
  };
  try {
    const status = getRerankerStatus();
    reranker = {
      enabled: status.enabled,
      status: status.mode,
      model: status.modelPath
        ? resolveModelName(
            undefined,
            status.modelPath,
            discoverModels("reranker")
          )
        : null,
      loaded: status.loaded,
      modelPath: status.modelPath,
      sizeBytes: status.sizeBytes,
    };
  } catch (err) {
    syslog("debug", "stats", `reranker stats resolution failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const [load1, load5, load15] = os.loadavg();
  const memoryAvailableBytes = getAvailableMemoryBytes();

  return {
    collectedAt: new Date().toISOString(),
    device: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      cpuModel: (cpus[0]?.model ?? "unknown").replace(/\s+/g, " ").trim(),
      cpuCores: cpus.length,
      nodeVersion: process.version,
      nextVersion: readNextVersion(),
      processUptimeSeconds: Math.round(process.uptime()),
    },
    resources: {
      loadAverage: [load1, load5, load15],
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      memoryAvailableBytes,
      processRssBytes: mem.rss,
      processHeapUsedBytes: mem.heapUsed,
      processHeapTotalBytes: mem.heapTotal,
      diskTotalBytes,
      diskFreeBytes,
      databaseSizeBytes,
    },
    gpu,
    services: { llm, embedding, reranker },
    scheduler: {
      daemonRunning: isCognitiveDaemonRunning(),
      queueRunnerRunning: isQueueRunnerRunning(),
      cron: getCronSchedules(),
    },
    database: getDatabaseStats(db),
  };
}
