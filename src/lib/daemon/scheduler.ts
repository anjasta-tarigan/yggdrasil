import cron, { ScheduledTask } from "node-cron";
import { db as defaultDb, type AppDatabase } from "@/db";
import { enqueueJob } from "@/lib/queue/queue";
import type { JobType } from "@/lib/queue/types";
import { syslog } from "@/lib/observability/log-store";
import {
  listCronSchedules,
  type CronJobConfig,
} from "./cron-jobs-service";

/**
 * Autonomous cognitive daemon — arms one node-cron task per configured
 * schedule (see cron-jobs-service.ts for the user-managed schedule store).
 * Every configured, enabled schedule maps to a queue job type; when the
 * timer fires, the job is enqueued into the durable queue and executed by
 * the queue runner with retry/backoff/GPU protection. The schedule layer
 * only decides *when*.
 *
 * Backwards compatibility: the historical hardcoded passes (light_sleep,
 * dream_cycle, decay_sweep) map to the seeded built-in schedule rows, so
 * `triggerMaintenancePass` keeps working for the old API shape.
 */

export type MaintenancePass = "light_sleep" | "dream_cycle" | "decay_sweep";

/** @deprecated Kept for backwards compatibility with older clients. */
export const CRON_SCHEDULES = {
  lightSleep: "*/15 * * * *",
  dreamCycle: "0 * * * *",
  decaySweep: "0 3 * * *",
  proactiveEvents: "0 * * * *",
} as const;

export function getCronSchedules() {
  return { ...CRON_SCHEDULES };
}

/** Map the historical pass names to their queue job types. */
const MAINTENANCE_PASS_TO_JOB_TYPE: Record<MaintenancePass, JobType> = {
  light_sleep: "sleep_consolidation",
  dream_cycle: "dream_graph_discovery",
  decay_sweep: "decay_sweep",
};

/** The seeded built-in schedule ids (see cron-jobs-service.ts). */
const BUILT_IN_ID_TO_PASS: Record<string, MaintenancePass> = {
  cron_sleep_consolidation: "light_sleep",
  cron_dream_graph_discovery: "dream_cycle",
  cron_decay_sweep: "decay_sweep",
};

export { BUILT_IN_ID_TO_PASS };

/**
 * Daemon state lives on globalThis so dev-server HMR module reloads cannot
 * orphan cron tasks: a reloaded module still sees (and can stop) the tasks
 * scheduled by the previous module generation.
 */
type DaemonGlobalState = {
  tasks: ScheduledTask[];
  taskIds: Set<string>;
  running: boolean;
};

const DAEMON_GLOBAL_KEY = "__yggdrasilCognitiveDaemon";

function daemonGlobal(): DaemonGlobalState {
  const g = globalThis as unknown as Record<string, DaemonGlobalState | undefined>;
  if (!g[DAEMON_GLOBAL_KEY]) {
    g[DAEMON_GLOBAL_KEY] = { tasks: [], taskIds: new Set(), running: false };
  }
  return g[DAEMON_GLOBAL_KEY];
}

/**
 * Manually trigger an immediate maintenance pass by enqueuing a durable job.
 * (Backwards-compatible shim; new code should use runCronScheduleNow.)
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

function scheduleTaskForConfig(
  config: CronJobConfig,
  dbInstance: AppDatabase
): ScheduledTask {
  return cron.schedule(config.schedule, () => {
    void enqueueJob(
      {
        type: config.jobType,
        payload: {
          triggeredBy: "cron",
          cronScheduleId: config.id,
          cronScheduleName: config.name,
          firedAt: new Date().toISOString(),
        },
        runAt: new Date(),
      },
      dbInstance
    ).catch((err) => {
      console.error(
        `[CognitiveDaemon] Error enqueueing "${config.name}" (${config.id}):`,
        err
      );
    });
  });
}

/**
 * (Re)arm the daemon from the currently configured schedules. Stops all
 * tasks, then schedules every enabled row. Called on boot and after every
 * schedule mutation, so user changes apply live without a server restart.
 */
export function syncCognitiveDaemon(dbInstance: AppDatabase = defaultDb): {
  armed: number;
  skipped: number;
} {
  const state = daemonGlobal();

  for (const task of state.tasks) {
    try {
      task.stop();
    } catch (err) {
      console.warn("[CognitiveDaemon] Error stopping cron task:", err);
    }
  }
  state.tasks = [];
  state.taskIds = new Set();

  const configs = listCronSchedules(dbInstance);
  let armed = 0;
  let skipped = 0;

  for (const config of configs) {
    if (!config.enabled) {
      skipped++;
      continue;
    }
    const task = scheduleTaskForConfig(config, dbInstance);
    state.tasks.push(task);
    state.taskIds.add(config.id);
    armed++;
  }

  state.running = true;
  syslog(
    "info",
    "daemon",
    `Cognitive daemon synced: ${armed} armed, ${skipped} disabled (${configs.length} configured)`
  );
  return { armed, skipped };
}

/**
 * Initialize the autonomous cognitive background daemon scheduler.
 * Arms one task per enabled configured schedule (seeded with the 3
 * historical built-in passes on first boot).
 */
export function initCognitiveDaemon(dbInstance: AppDatabase = defaultDb): void {
  syncCognitiveDaemon(dbInstance);
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
  state.taskIds = new Set();
  state.running = false;
}

export function isCognitiveDaemonRunning(): boolean {
  return daemonGlobal().running;
}

/** Test hook: ids of the schedules currently armed. */
export function getArmedScheduleIds(): string[] {
  return [...daemonGlobal().taskIds];
}
