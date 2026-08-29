import cron from "node-cron";
import { db as defaultDb, type AppDatabase } from "@/db";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { syslog } from "@/lib/observability/log-store";
import { enqueueJob } from "@/lib/queue/queue";
import type { JobType } from "@/lib/queue/types";

/**
 * Configurable cron schedules — the user-managed half of the cognitive
 * daemon. Schedules live in the `settings` table under key "cronSchedules"
 * so they survive restarts and can be edited at runtime from the Cron Jobs
 * page. The daemon scheduler re-reads them on every mutation and swaps its
 * node-cron tasks in place (no server restart needed).
 *
 * A schedule maps a cron expression to a queue job type. The queue runner
 * executes the actual work (LLM consolidation, graph discovery, decay,
 * reminders) with its usual retry/backoff/GPU-deferral machinery — the
 * schedule only decides *when* to enqueue.
 *
 * Built-in defaults are seeded on first read; the built-in maintenance
 * passes remain individually editable, disableable and removable.
 */

export type CronJobId = string;

export interface CronJobConfig {
  /** Stable unique id (nanoid). */
  id: CronJobId;
  /** Human label shown in the UI. */
  name: string;
  /** node-cron 5-field expression (validated before persisting). */
  schedule: string;
  /** Queue job type the schedule enqueues when it fires. */
  jobType: JobType;
  /** Enabled schedules are armed by the daemon; disabled ones are stored only. */
  enabled: boolean;
  /** Free-form note shown under the name in the UI. */
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** Whether this row came from the built-in seed (informational only). */
  builtIn?: boolean;
}

/** Settings key under which the schedule list is persisted. */
const CRON_SETTINGS_KEY = "cronSchedules";

/** Bound the stored list to keep the settings row sane. */
const MAX_SCHEDULES = 50;

/**
 * Job types users can schedule. Chat-driven types (ingest_turn,
 * reflect_turn) are excluded: they are triggered per conversation turn, not
 * on a wall-clock schedule. scheduled_reminder is a one-shot delay job
 * (created by the reminder tool with a runAt timestamp), not a recurring
 * pass.
 */
export const SCHEDULABLE_JOB_TYPES: ReadonlyArray<{
  jobType: JobType;
  label: string;
  description: string;
}> = [
  {
    jobType: "sleep_consolidation",
    label: "Light Sleep Consolidation",
    description:
      "Summarizes recent episodic memories into semantic knowledge (LLM)",
  },
  {
    jobType: "dream_graph_discovery",
    label: "Dream Cycle Discovery",
    description:
      "Discovers associative relationship edges between semantic memories (SQL)",
  },
  {
    jobType: "decay_sweep",
    label: "Deep Sleep Decay Sweep",
    description:
      "Applies Ebbinghaus forgetting-curve decay and prunes dangling edges (SQL)",
  },
];

const SCHEDULABLE_TYPE_SET: ReadonlySet<string> = new Set(
  SCHEDULABLE_JOB_TYPES.map((t) => t.jobType)
);

/** Built-in seed schedules (previously hardcoded in the daemon). */
export const BUILT_IN_SCHEDULES: ReadonlyArray<
  Omit<CronJobConfig, "id" | "createdAt" | "updatedAt">
> = [
  {
    name: "Light Sleep Consolidation",
    schedule: "*/15 * * * *",
    jobType: "sleep_consolidation",
    enabled: true,
    description:
      "Consolidates and summarizes recent episodic memories into semantic knowledge",
    builtIn: true,
  },
  {
    name: "Dream Cycle Discovery",
    schedule: "0 * * * *",
    jobType: "dream_graph_discovery",
    enabled: true,
    description:
      "Scans semantic memories to discover new associative relationship links",
    builtIn: true,
  },
  {
    name: "Deep Sleep Decay Sweep",
    schedule: "0 3 * * *",
    jobType: "decay_sweep",
    enabled: true,
    description:
      "Applies Ebbinghaus forgetting curve decay and prunes dangling edges",
    builtIn: true,
  },
];

/** Validate a 5-field cron expression using node-cron itself. */
export function isValidCronExpression(expression: string): boolean {
  try {
    return cron.validate(expression);
  } catch {
    return false;
  }
}

/** Describe cron validation errors field by field (for API error bodies). */
export function describeCronExpressionErrors(expression: string): string[] {
  try {
    const detailed = cron.validateDetailed(expression);
    if (detailed.valid) return [];
    return detailed.errors.map((e) => `${e.field}: ${e.message}`);
  } catch {
    return ["expression: failed to parse"];
  }
}

/**
 * Runtime shape check for a stored schedule row. Storage is a JSON blob;
 * be tolerant of optional fields but strict about types.
 */
function isCronJobShape(value: unknown): value is CronJobConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    v.id.length <= 128 &&
    typeof v.name === "string" &&
    v.name.length > 0 &&
    v.name.length <= 128 &&
    typeof v.schedule === "string" &&
    isValidCronExpression(v.schedule) &&
    typeof v.jobType === "string" &&
    SCHEDULABLE_TYPE_SET.has(v.jobType) &&
    typeof v.enabled === "boolean" &&
    (v.description === undefined ||
      (typeof v.description === "string" && v.description.length <= 500)) &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string"
  );
}

/**
 * Read all schedules. Seeds the built-in defaults on first access (empty or
 * missing settings row) so a fresh install matches the previous hardcoded
 * daemon behaviour.
 */
export function listCronSchedules(
  db: AppDatabase = defaultDb
): CronJobConfig[] {
  const stored = getSettingDb(CRON_SETTINGS_KEY, db);
  if (stored === undefined) {
    const seeded = seedBuiltInSchedules(db);
    return seeded;
  }
  if (!Array.isArray(stored)) return [];
  return stored.filter(isCronJobShape);
}

/** Insert the built-in defaults; returns what was written. */
function seedBuiltInSchedules(db: AppDatabase): CronJobConfig[] {
  const now = new Date().toISOString();
  const seeded = BUILT_IN_SCHEDULES.map((entry) => ({
    ...entry,
    id: `cron_${entry.jobType}`,
    createdAt: now,
    updatedAt: now,
  }));
  setSettingsDb({ [CRON_SETTINGS_KEY]: seeded }, db);
  syslog(
    "info",
    "daemon",
    `Seeded ${seeded.length} built-in cron schedules (settings key "${CRON_SETTINGS_KEY}")`
  );
  return seeded;
}

function persistSchedules(schedules: CronJobConfig[], db: AppDatabase): void {
  setSettingsDb({ [CRON_SETTINGS_KEY]: schedules }, db);
}

export interface CronJobInput {
  name: string;
  schedule: string;
  jobType: JobType;
  enabled?: boolean;
  description?: string;
}

/** Validate the user-facing create payload; returns error strings. */
export function validateCronJobInput(input: {
  name?: unknown;
  schedule?: unknown;
  jobType?: unknown;
  enabled?: unknown;
  description?: unknown;
}): string[] {
  const errors: string[] = [];
  if (
    typeof input.name !== "string" ||
    input.name.trim().length === 0 ||
    input.name.length > 128
  ) {
    errors.push("name must be a non-empty string (max 128 chars)");
  }
  if (typeof input.schedule !== "string" || !isValidCronExpression(input.schedule)) {
    errors.push(
      `schedule must be a valid cron expression${
        typeof input.schedule === "string"
          ? ` (${describeCronExpressionErrors(input.schedule).join("; ")})`
          : ""
      }`
    );
  }
  if (
    typeof input.jobType !== "string" ||
    !SCHEDULABLE_TYPE_SET.has(input.jobType)
  ) {
    errors.push(
      `jobType must be one of: ${SCHEDULABLE_JOB_TYPES.map((t) => t.jobType).join(", ")}`
    );
  }
  if (
    input.enabled !== undefined &&
    typeof input.enabled !== "boolean"
  ) {
    errors.push("enabled must be a boolean");
  }
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 500)
  ) {
    errors.push("description must be a string (max 500 chars)");
  }
  return errors;
}

/** Create a new schedule. Throws on validation failure or when full. */
export async function createCronSchedule(
  input: CronJobInput,
  db: AppDatabase = defaultDb
): Promise<CronJobConfig> {
  const errors = validateCronJobInput(input);
  if (errors.length > 0) {
    throw new CronValidationError(errors);
  }

  const existing = listCronSchedules(db);
  if (existing.length >= MAX_SCHEDULES) {
    throw new CronValidationError([`Maximum of ${MAX_SCHEDULES} schedules reached`]);
  }

  const { nanoid } = await import("nanoid");
  const now = new Date().toISOString();
  const job: CronJobConfig = {
    id: `cron_${nanoid(10)}`,
    name: input.name.trim(),
    schedule: input.schedule,
    jobType: input.jobType,
    enabled: input.enabled ?? true,
    description: input.description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  persistSchedules([...existing, job], db);
  syslog(
    "info",
    "daemon",
    `Cron schedule created: "${job.name}" (${job.schedule} → ${job.jobType}, id ${job.id})`
  );
  return job;
}

/** Update an existing schedule by id; returns null when not found. */
export async function updateCronSchedule(
  id: CronJobId,
  patch: Partial<CronJobInput>,
  db: AppDatabase = defaultDb
): Promise<CronJobConfig | null> {
  const existing = listCronSchedules(db);
  const idx = existing.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  const current = existing[idx];
  const candidate = {
    name: patch.name ?? current.name,
    schedule: patch.schedule ?? current.schedule,
    jobType: patch.jobType ?? current.jobType,
    enabled: patch.enabled ?? current.enabled,
    description: patch.description ?? current.description,
  };

  const errors = validateCronJobInput(candidate);
  if (errors.length > 0) {
    throw new CronValidationError(errors);
  }

  const updated: CronJobConfig = {
    ...current,
    name: candidate.name.trim(),
    schedule: candidate.schedule,
    jobType: candidate.jobType,
    enabled: candidate.enabled,
    description: candidate.description?.trim() || undefined,
    updatedAt: new Date().toISOString(),
  };
  existing[idx] = updated;
  persistSchedules(existing, db);
  syslog(
    "info",
    "daemon",
    `Cron schedule updated: "${updated.name}" (${updated.schedule} → ${updated.jobType}, id ${updated.id})`
  );
  return updated;
}

/** Delete a schedule by id; returns the removed row or null. */
export function deleteCronSchedule(
  id: CronJobId,
  db: AppDatabase = defaultDb
): CronJobConfig | null {
  const existing = listCronSchedules(db);
  const idx = existing.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const [removed] = existing.splice(idx, 1);
  persistSchedules(existing, db);
  syslog(
    "info",
    "daemon",
    `Cron schedule deleted: "${removed.name}" (id ${removed.id})`
  );
  return removed;
}

/** Validation error carrying per-field messages. */
export class CronValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "CronValidationError";
    this.issues = issues;
  }
}

/**
 * Fire a configured schedule's job type immediately (used by the "Run now"
 * button). Bypasses the cron timer and enqueues straight into the queue.
 */
export async function runCronScheduleNow(
  id: CronJobId,
  db: AppDatabase = defaultDb
): Promise<string | null> {
  const schedules = listCronSchedules(db);
  const job = schedules.find((s) => s.id === id);
  if (!job) return null;

  const jobId = await enqueueJob(
    {
      type: job.jobType,
      payload: {
        triggeredBy: "manual_pass",
        cronScheduleId: job.id,
        cronScheduleName: job.name,
        triggeredAt: new Date().toISOString(),
      },
      runAt: new Date(),
    },
    db
  );
  syslog(
    "info",
    "daemon",
    `Manual pass for cron schedule "${job.name}" enqueued (job ${jobId})`
  );
  return jobId;
}

/**
 * Compute the next fire time for a schedule. Returns ISO string or null
 * when the expression has no future occurrence (or is invalid). Scheduling
 * semantics follow node-cron defaults (server-local timezone), same as the
 * live daemon tasks.
 *
 * node-cron 4.x runs each task in a forked child process; a throwaway task
 * created here starts its fork briefly and is stopped immediately after
 * reading the next-run projection.
 */
export function getNextRunIso(
  schedule: string,
  from: Date = new Date()
): string | null {
  if (!isValidCronExpression(schedule)) return null;
  try {
    const task = cron.schedule(schedule, () => {});
    const next = task.getNextRun();
    task.stop();
    if (!next) return null;
    // node-cron computes from Date.now(); never return a time earlier than
    // `from` + 1 minute (guards callers passing an explicit `from`).
    const earliest = new Date(from.getTime() + 60_000);
    if (next.getTime() < earliest.getTime() && from.getTime() > Date.now() - 60_000) {
      return null;
    }
    return next.toISOString();
  } catch {
    return null;
  }
}
