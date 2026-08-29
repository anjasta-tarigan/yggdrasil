import { NextResponse } from "next/server";
import { db as defaultDb } from "@/db";
import { jobQueue } from "@/db/schema";
import { desc, sql } from "drizzle-orm";
import {
  isCognitiveDaemonRunning,
  syncCognitiveDaemon,
  triggerMaintenancePass,
  type MaintenancePass,
} from "@/lib/daemon/scheduler";
import {
  listCronSchedules,
  getNextRunIso,
  SCHEDULABLE_JOB_TYPES,
} from "@/lib/daemon/cron-jobs-service";
import { isQueueRunnerRunning } from "@/lib/queue/runner";

export const dynamic = "force-dynamic";

export interface CronJobScheduleInfo {
  id: string;
  name: string;
  schedule: string;
  description: string;
  jobType: string;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  builtIn?: boolean;
}

/** Page size for the recent executions list. */
const JOB_PAGE_SIZE = 20;
const MAX_JOB_PAGE_SIZE = 100;

/**
 * Next-run cache: getNextRunIso creates and stops a throwaway node-cron
 * task — a forked child process — per call, and this route is polled every
 * 5 seconds by the Cron Jobs page. A projection that is ≥30s away cannot
 * change meaningfully between polls, so cache per schedule expression
 * until it fires (or the cache entry expires, whichever first).
 */
const NEXT_RUN_TTL_MS = 30_000;
const nextRunCache = new Map<string, { at: string; expiry: number }>();

function cachedNextRunIso(schedule: string): string | null {
  const now = Date.now();
  const cached = nextRunCache.get(schedule);
  if (cached) {
    if (cached.expiry > now) return cached.at;
    // A cached projection that has not yet come due is still current.
    const cachedAtMs = new Date(cached.at).getTime();
    if (cachedAtMs > now) return cached.at;
  }
  const at = getNextRunIso(schedule);
  if (at) {
    const atMs = new Date(at).getTime();
    nextRunCache.set(schedule, {
      at,
      expiry: Math.min(atMs, now + NEXT_RUN_TTL_MS),
    });
  } else {
    nextRunCache.delete(schedule);
  }
  return at;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  // null (missing query param) coerces to 0, not NaN — treat it as missing.
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Returns configured cron schedules (with next fire times), daemon status,
 * and a paginated page of recent job queue executions.
 * Query params: page (1-based), pageSize (default 20, max 100).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    // Pass raw param strings — Number(null) is 0, which would defeat the
    // fallback; clampInt treats null/"" as "missing".
    const page = clampInt(url.searchParams.get("page"), 1, 100_000, 1);
    const pageSize = clampInt(
      url.searchParams.get("pageSize"),
      1,
      MAX_JOB_PAGE_SIZE,
      JOB_PAGE_SIZE
    );

    const daemonRunning = isCognitiveDaemonRunning();
    const queueRunnerRunning = isQueueRunnerRunning();

    const schedules = listCronSchedules().map<CronJobScheduleInfo>((s) => ({
      id: s.id,
      name: s.name,
      schedule: s.schedule,
      description: s.description ?? "",
      jobType: s.jobType,
      enabled: s.enabled,
      nextRunAt: s.enabled ? cachedNextRunIso(s.schedule) : null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      ...(s.builtIn ? { builtIn: true } : {}),
    }));

    // Paginated recent jobs (newest first) + total count for page controls.
    const [{ total }] = defaultDb
      .select({ total: sql<number>`count(*)` })
      .from(jobQueue)
      .all();

    const recentJobs = defaultDb
      .select()
      .from(jobQueue)
      .orderBy(desc(jobQueue.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    const jobsWithParsedDates = recentJobs.map((job) => ({
      id: job.id,
      type: job.type,
      payload: job.payload,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      lastError: job.lastError,
      lockedAt: job.lockedAt ? new Date(job.lockedAt).toISOString() : null,
      runAt: job.runAt ? new Date(job.runAt).toISOString() : null,
      createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      updatedAt: job.updatedAt ? new Date(job.updatedAt).toISOString() : null,
    }));

    return NextResponse.json({
      daemonRunning,
      queueRunnerRunning,
      schedules,
      schedulableJobTypes: SCHEDULABLE_JOB_TYPES,
      recentJobs: jobsWithParsedDates,
      jobsPagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (error) {
    console.error("[api/cron] GET error:", error);
    return NextResponse.json(
      { error: "Failed to fetch cron job status" },
      { status: 500 }
    );
  }
}

/**
 * Triggers a manual execution of a cron / maintenance job.
 * Body: { pass: "light_sleep" | "dream_cycle" | "decay_sweep" }
 * (legacy shape) or { scheduleId: "cron_..." } (new shape).
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = body as Record<string, unknown>;

  // New shape: run a configured schedule by id.
  if (typeof parsed?.scheduleId === "string") {
    const { runCronScheduleNow } = await import("@/lib/daemon/cron-jobs-service");
    try {
      const jobId = await runCronScheduleNow(parsed.scheduleId);
      if (!jobId) {
        return NextResponse.json(
          { error: "Schedule not found" },
          { status: 404 }
        );
      }
      return NextResponse.json({ success: true, jobId });
    } catch (error) {
      console.error("[api/cron] POST run-now error:", error);
      return NextResponse.json(
        { error: "Failed to trigger schedule" },
        { status: 500 }
      );
    }
  }

  // Legacy shape: pass name.
  const pass = parsed?.pass;
  const validPasses: MaintenancePass[] = ["light_sleep", "dream_cycle", "decay_sweep"];

  if (typeof pass !== "string" || !validPasses.includes(pass as MaintenancePass)) {
    return NextResponse.json(
      { error: `pass must be one of: ${validPasses.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const jobId = await triggerMaintenancePass(pass as MaintenancePass);
    return NextResponse.json({ success: true, jobId });
  } catch (error) {
    console.error("[api/cron] POST error:", error);
    return NextResponse.json(
      { error: "Failed to trigger cron job" },
      { status: 500 }
    );
  }
}
