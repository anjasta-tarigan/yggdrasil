import cron, { ScheduledTask } from "node-cron";
import { db as defaultDb, type AppDatabase } from "@/db";
import { enqueueJob } from "@/lib/queue/queue";
import type { JobType } from "@/lib/queue/types";
import { syslog } from "@/lib/observability/log-store";

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

/**
 * Daemon state lives on globalThis so dev-server HMR module reloads cannot
 * orphan cron tasks: a reloaded module still sees (and can stop) the tasks
 * scheduled by the previous module generation.
 */
type DaemonGlobalState = {
  tasks: ScheduledTask[];
  running: boolean;
};

const DAEMON_GLOBAL_KEY = "__yggdrasilCognitiveDaemon";

function daemonGlobal(): DaemonGlobalState {
  const g = globalThis as unknown as Record<string, DaemonGlobalState | undefined>;
  if (!g[DAEMON_GLOBAL_KEY]) {
    g[DAEMON_GLOBAL_KEY] = { tasks: [], running: false };
  }
  return g[DAEMON_GLOBAL_KEY];
}

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

  syslog("info", "daemon", `Manual maintenance pass "${pass}" enqueued (job ${jobId})`);
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
  if (daemonGlobal().running) {
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

  const state = daemonGlobal();
  state.tasks = [lightSleepTask, dreamCycleTask, decaySweepTask];
  state.running = true;
  syslog(
    "info",
    "daemon",
    `Cognitive daemon scheduled: light sleep ${CRON_SCHEDULES.lightSleep}, dream ${CRON_SCHEDULES.dreamCycle}, decay ${CRON_SCHEDULES.decaySweep}`
  );
}

/**
 * Stop and unregister all running scheduled cron tasks cleanly.
 */
export function stopCognitiveDaemon(): void {
  const state = daemonGlobal();
  for (const task of state.tasks) {
    try {
      task.stop();
    } catch (err) {
      console.warn("[CognitiveDaemon] Error stopping cron task:", err);
    }
  }
  state.tasks = [];
  state.running = false;
}

export function isCognitiveDaemonRunning(): boolean {
  return daemonGlobal().running;
}
