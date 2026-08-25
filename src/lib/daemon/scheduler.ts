import cron, { ScheduledTask } from "node-cron";
import { db as defaultDb, type AppDatabase } from "@/db";
import { enqueueJob } from "@/lib/queue/queue";
import type { JobType } from "@/lib/queue/types";

export type MaintenancePass = "light_sleep" | "dream_cycle" | "decay_sweep";

export const CRON_SCHEDULES = {
  lightSleep: "*/15 * * * *", // 15m Light Sleep consolidation
  dreamCycle: "0 * * * *",    // 1h Dream Cycle graph edge discovery
  decaySweep: "0 3 * * *",    // 24h Deep Sleep decay sweep (every day at 3:00 AM)
} as const;

export function getCronSchedules() {
  return { ...CRON_SCHEDULES };
}

const MAINTENANCE_PASS_TO_JOB_TYPE: Record<MaintenancePass, JobType> = {
  light_sleep: "sleep_consolidation",
  dream_cycle: "dream_graph_discovery",
  decay_sweep: "decay_sweep",
};

let scheduledTasks: ScheduledTask[] = [];
let isDaemonRunning = false;

/**
 * Manually trigger an immediate maintenance pass by enqueuing a durable job.
 */
export async function triggerMaintenancePass(
  pass: MaintenancePass,
  dbInstance: AppDatabase = defaultDb
): Promise<string> {
  const jobType = MAINTENANCE_PASS_TO_JOB_TYPE[pass];
  if (!jobType) {
    throw new Error(`Unknown maintenance pass: ${pass}`);
  }

  const jobId = await enqueueJob(
    {
      type: jobType,
      payload: {
        triggeredBy: "manual_pass",
        passName: pass,
        triggeredAt: new Date().toISOString(),
      },
      runAt: new Date(),
    },
    dbInstance
  );

  return jobId;
}

/**
 * Initialize the autonomous cognitive background daemon scheduler.
 * Sets up 3 recurring cron schedules:
 * 1. 15m Light Sleep consolidation (episodic -> semantic summarization)
 * 2. 1h Dream Cycle (graph edge discovery & associative links)
 * 3. 24h Deep Sleep decay sweep (Ebbinghaus decay curve & dangling edge cleanup)
 */
export function initCognitiveDaemon(dbInstance: AppDatabase = defaultDb): void {
  if (isDaemonRunning) {
    stopCognitiveDaemon();
  }

  const lightSleepTask = cron.schedule(CRON_SCHEDULES.lightSleep, () => {
    void enqueueJob(
      {
        type: "sleep_consolidation",
        payload: { triggeredBy: "cron_light_sleep" },
        runAt: new Date(),
      },
      dbInstance
    ).catch((err) => {
      console.error("[CognitiveDaemon] Error scheduling light sleep consolidation job:", err);
    });
  });

  const dreamCycleTask = cron.schedule(CRON_SCHEDULES.dreamCycle, () => {
    void enqueueJob(
      {
        type: "dream_graph_discovery",
        payload: { triggeredBy: "cron_dream_cycle" },
        runAt: new Date(),
      },
      dbInstance
    ).catch((err) => {
      console.error("[CognitiveDaemon] Error scheduling dream cycle job:", err);
    });
  });

  const decaySweepTask = cron.schedule(CRON_SCHEDULES.decaySweep, () => {
    void enqueueJob(
      {
        type: "decay_sweep",
        payload: { triggeredBy: "cron_decay_sweep" },
        runAt: new Date(),
      },
      dbInstance
    ).catch((err) => {
      console.error("[CognitiveDaemon] Error scheduling decay sweep job:", err);
    });
  });

  scheduledTasks = [lightSleepTask, dreamCycleTask, decaySweepTask];
  isDaemonRunning = true;
}

/**
 * Stop and unregister all running scheduled cron tasks cleanly.
 */
export function stopCognitiveDaemon(): void {
  for (const task of scheduledTasks) {
    try {
      task.stop();
    } catch (err) {
      console.warn("[CognitiveDaemon] Error stopping cron task:", err);
    }
  }
  scheduledTasks = [];
  isDaemonRunning = false;
}
