import { NextResponse } from "next/server";
import { db as defaultDb } from "@/db";
import { jobQueue } from "@/db/schema";
import { desc } from "drizzle-orm";
import {
  getCronSchedules,
  isCognitiveDaemonRunning,
  triggerMaintenancePass,
  type MaintenancePass,
} from "@/lib/daemon/scheduler";
import { isQueueRunnerRunning } from "@/lib/queue/runner";

export const dynamic = "force-dynamic";

export interface CronJobScheduleInfo {
  name: string;
  schedule: string;
  description: string;
  passName: MaintenancePass;
  jobType: string;
}

export const CRON_JOB_DEFINITIONS: CronJobScheduleInfo[] = [
  {
    name: "Light Sleep Consolidation",
    schedule: "*/15 * * * *",
    description: "Consolidates and summarizes recent episodic memories into semantic knowledge",
    passName: "light_sleep",
    jobType: "sleep_consolidation",
  },
  {
    name: "Dream Cycle Discovery",
    schedule: "0 * * * *",
    description: "Scans semantic memories to discover new associative relationship links",
    passName: "dream_cycle",
    jobType: "dream_graph_discovery",
  },
  {
    name: "Deep Sleep Decay Sweep",
    schedule: "0 3 * * *",
    description: "Applies Ebbinghaus forgetting curve decay and prunes dangling edges",
    passName: "decay_sweep",
    jobType: "decay_sweep",
  },
];

/**
 * Returns cron schedules, daemon status, and recent job queue executions.
 */
export async function GET() {
  try {
    const schedules = getCronSchedules();
    const daemonRunning = isCognitiveDaemonRunning();
    const queueRunnerRunning = isQueueRunnerRunning();

    // Fetch the recent 50 jobs from the job queue
    const recentJobs = defaultDb
      .select()
      .from(jobQueue)
      .orderBy(desc(jobQueue.createdAt))
      .limit(50)
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
      definitions: CRON_JOB_DEFINITIONS,
      recentJobs: jobsWithParsedDates,
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
 * Triggers a manual execution of a cron / maintenance job pass.
 * Body: { pass: "light_sleep" | "dream_cycle" | "decay_sweep" }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pass = (body as Record<string, unknown>)?.pass;
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
