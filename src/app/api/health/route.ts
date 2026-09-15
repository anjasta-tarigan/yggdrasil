import { bootstrapAutonomousCognitiveSystem } from "@/lib/bootstrap";
import { sqlite } from "@/db";
import { isQueueRunnerRunning } from "@/lib/queue/runner";
import {
  isCognitiveDaemonRunning,
  getArmedScheduleIds,
} from "@/lib/daemon/scheduler";
import { loadRegistry } from "@/lib/ai/provider-config/store";
import {
  getEmbeddingConfigFromRegistry,
  getOnnxEmbeddingStatus,
  type OnnxEmbeddingStatus,
} from "@/lib/memory/embeddings";
import { getRerankerStatus } from "@/lib/memory/reranker";
import { discoverModels } from "@/lib/models/store";
import {
  mapEmbeddingHealth,
  mapRerankerHealth,
  unloadedService,
} from "@/lib/health/service-status";
import { syslog } from "@/lib/observability/log-store";
import type {
  ServiceHealth,
  DatabaseSubsystemHealth,
  QueueSubsystemHealth,
  DaemonSubsystemHealth,
  InternalSubsystemHealth,
  HealthStatus,
} from "@/hooks/use-system-health";
import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

/**
 * High-performance internal system health probe for Yggdrasil.
 *
 * Checks core internal subsystems rather than third-party AI provider endpoints:
 * 1. SQLite Database responsiveness & WAL status
 * 2. Background Queue Runner status & pending/failed counts
 * 3. Autonomous Cognitive Loop Daemon status & armed schedule count
 * 4. Local ONNX service states (embedding engine & reranker)
 * 5. Node.js runtime metrics (process uptime, memory heap usage)
 *
 * This check executes locally in ~1-2ms with zero external network dependencies,
 * ensuring CLI checks and frontend status indicators remain instant and resilient.
 */

function checkDatabase(): DatabaseSubsystemHealth {
  try {
    const started = performance.now();
    sqlite.prepare("SELECT 1").get();
    const latencyMs = Math.round(performance.now() - started);
    const journalMode =
      (sqlite.pragma("journal_mode", { simple: true }) as string) || "";
    return {
      status: "ok",
      latencyMs,
      wal: journalMode.toLowerCase() === "wal",
    };
  } catch (err) {
    return {
      status: "down",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function checkQueue(): QueueSubsystemHealth {
  let running = false;
  try {
    running = isQueueRunnerRunning();
  } catch (err) {
    syslog("debug", "health", `checkQueue: isQueueRunnerRunning failed: ${err instanceof Error ? err.message : String(err)}`);
    running = false;
  }

  let pendingJobs: number | undefined;
  let failedJobs: number | undefined;
  try {
    const pendingRow = sqlite
      .prepare("SELECT COUNT(*) as c FROM job_queue WHERE status = 'pending'")
      .get() as { c: number } | undefined;
    pendingJobs = pendingRow?.c ?? 0;

    const failedRow = sqlite
      .prepare("SELECT COUNT(*) as c FROM job_queue WHERE status = 'failed'")
      .get() as { c: number } | undefined;
    failedJobs = failedRow?.c ?? 0;
  } catch (err) {
    // If job_queue table doesn't exist yet or query fails, leave undefined
    syslog("debug", "health", `checkQueue: query job_queue failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const status: "ok" | "degraded" | "down" =
    (failedJobs ?? 0) > 50 ? "degraded" : "ok";

  return {
    status,
    running,
    pendingJobs,
    failedJobs,
  };
}

function checkDaemon(): DaemonSubsystemHealth {
  let running = false;
  let armedSchedules = 0;
  try {
    running = isCognitiveDaemonRunning();
    armedSchedules = getArmedScheduleIds().length;
  } catch (err) {
    syslog("debug", "health", `checkDaemon failed: ${err instanceof Error ? err.message : String(err)}`);
    running = false;
  }

  return {
    status: running ? "ok" : "degraded",
    running,
    armedSchedules,
  };
}

/** Resolve the embedding + reranker lifecycle summaries (never throws). */
async function collectServiceHealth(): Promise<{
  embedding: ServiceHealth;
  reranker: ServiceHealth;
}> {
  let embedding: ServiceHealth;
  try {
    const config = await getEmbeddingConfigFromRegistry();
    let onnxStatus: OnnxEmbeddingStatus | null = null;
    if (config.provider === "onnx") {
      try {
        onnxStatus = getOnnxEmbeddingStatus(config.modelPath);
      } catch (err) {
        syslog("debug", "health", `getOnnxEmbeddingStatus failed: ${err instanceof Error ? err.message : String(err)}`);
        onnxStatus = null;
      }
    }
    const discovered =
      config.provider === "onnx" ? discoverModels("embedding") : [];
    embedding = mapEmbeddingHealth(config, onnxStatus, discovered);
  } catch (err) {
    syslog("debug", "health", `collectServiceHealth (embedding) failed: ${err instanceof Error ? err.message : String(err)}`);
    embedding = unloadedService("unconfigured");
  }

  let reranker: ServiceHealth;
  try {
    const status = getRerankerStatus();
    reranker = mapRerankerHealth(status, discoverModels("reranker"));
  } catch (err) {
    syslog("debug", "health", `collectServiceHealth (reranker) failed: ${err instanceof Error ? err.message : String(err)}`);
    reranker = unloadedService("unconfigured");
  }

  return { embedding, reranker };
}

export async function GET() {
  // Ensure cognitive loop & background runners are bootstrapped
  try {
    bootstrapAutonomousCognitiveSystem();
  } catch (err) {
    console.error("[Health] Failed to bootstrap autonomous cognitive system:", err);
  }

  const timestamp = Date.now();
  const version = pkg.version || "0.1.0";
  const uptimeSeconds = Math.round(process.uptime());
  const memoryHeapMb = Math.round(
    process.memoryUsage().heapUsed / (1024 * 1024)
  );

  const stampServerTime = () => ({
    now: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  const services = await collectServiceHealth();
  const dbHealth = checkDatabase();
  const queueHealth = checkQueue();
  const daemonHealth = checkDaemon();

  let overallStatus: HealthStatus = "ok";
  if (dbHealth.status === "down") {
    overallStatus = "down";
  } else if (dbHealth.status === "degraded" || queueHealth.status === "degraded") {
    overallStatus = "degraded";
  }

  let modelId: string | null = null;
  try {
    const doc = await loadRegistry();
    const flagged = doc.providers.flatMap((p) =>
      p.models.filter((m) => m.isDefault)
    );
    modelId =
      flagged[0]?.modelId ?? doc.providers[0]?.models[0]?.modelId ?? null;
  } catch (err) {
    // Registry not configured or readable; keep null
    syslog("debug", "health", `loadRegistry failed in health check: ${err instanceof Error ? err.message : String(err)}`);
  }

  const subsystems: InternalSubsystemHealth = {
    database: dbHealth,
    queue: queueHealth,
    daemon: daemonHealth,
  };

  return Response.json({
    status: overallStatus,
    timestamp,
    version,
    uptimeSeconds,
    memoryHeapMb,
    modelId,
    services,
    subsystems,
    serverTime: stampServerTime(),
    ...(dbHealth.error ? { error: dbHealth.error } : {}),
  });
}
