import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { databasePath, db as defaultDb, type AppDatabase } from "@/db";
import { getDatabaseStats, type DatabaseStats } from "./database-service";
import { getCronSchedules, isCognitiveDaemonRunning } from "./daemon/scheduler";
import { isQueueRunnerRunning } from "./queue/runner";
import { getEmbeddingConfig } from "./memory/embeddings";

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
    };
  };
  scheduler: {
    daemonRunning: boolean;
    queueRunnerRunning: boolean;
    cron: Record<string, string>;
  };
  database: DatabaseStats;
}

function readNextVersion(): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    return pkg.dependencies?.next ?? null;
  } catch {
    return null;
  }
}

function probeGpu(): Promise<GpuStats | null> {
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
          resolve(null);
          return;
        }
        const line = stdout.trim().split("\n")[0];
        const [name, memUsed, memTotal, util] = (line ?? "").split(",").map((s) => s?.trim());
        if (!name) {
          resolve(null);
          return;
        }
        resolve({
          name,
          memoryUsedMb: Number(memUsed) || 0,
          memoryTotalMb: Number(memTotal) || 0,
          utilizationPercent: Number(util) || 0,
        });
      }
    );
  });
}

async function probeLlmEndpoint(): Promise<SystemStats["services"]["llm"]> {
  const baseUrl = process.env.LLM_BASE_URL ?? null;
  const apiKey = process.env.LLM_API_KEY;
  const modelId = process.env.LLM_MODEL_ID ?? null;

  if (!baseUrl) {
    return { baseUrl, modelId, status: "unconfigured", latencyMs: null };
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
  } catch {
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
  } catch {
    // statfs unsupported on this platform — report zeros.
  }

  let databaseSizeBytes = 0;
  try {
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      if (fs.existsSync(file)) {
        databaseSizeBytes += fs.statSync(file).size;
      }
    }
  } catch {
    // DB file missing — report zero.
  }

  const [gpu, llm] = await Promise.all([probeGpu(), probeLlmEndpoint()]);

  let embedding: SystemStats["services"]["embedding"] = {
    provider: "server",
    baseUrl: null,
    model: null,
  };
  try {
    const emb = getEmbeddingConfig();
    embedding = {
      provider: emb.provider ?? "server",
      baseUrl: emb.baseUrl ?? null,
      model: emb.model ?? null,
    };
  } catch {
    // Settings store unavailable — keep defaults.
  }

  const [load1, load5, load15] = os.loadavg();

  return {
    collectedAt: new Date().toISOString(),
    device: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      cpuModel: cpus[0]?.model ?? "unknown",
      cpuCores: cpus.length,
      nodeVersion: process.version,
      nextVersion: readNextVersion(),
      processUptimeSeconds: Math.round(process.uptime()),
    },
    resources: {
      loadAverage: [load1, load5, load15],
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      processRssBytes: mem.rss,
      processHeapUsedBytes: mem.heapUsed,
      processHeapTotalBytes: mem.heapTotal,
      diskTotalBytes,
      diskFreeBytes,
      databaseSizeBytes,
    },
    gpu,
    services: { llm, embedding },
    scheduler: {
      daemonRunning: isCognitiveDaemonRunning(),
      queueRunnerRunning: isQueueRunnerRunning(),
      cron: getCronSchedules(),
    },
    database: getDatabaseStats(db),
  };
}
