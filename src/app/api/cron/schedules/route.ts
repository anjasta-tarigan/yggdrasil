import { NextResponse } from "next/server";
import { db as defaultDb } from "@/db";
import {
  CronValidationError,
  createCronSchedule,
  deleteCronSchedule,
  listCronSchedules,
  updateCronSchedule,
} from "@/lib/daemon/cron-jobs-service";
import { syncCognitiveDaemon } from "@/lib/daemon/scheduler";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/schedules — list configured schedules.
 */
export async function GET() {
  try {
    const schedules = listCronSchedules();
    return NextResponse.json({ schedules });
  } catch (error) {
    console.error("[api/cron/schedules] GET error:", error);
    return NextResponse.json(
      { error: "Failed to list schedules" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/cron/schedules — create a schedule.
 * Body: { name, schedule, jobType, enabled?, description? }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;

  try {
    const schedule = await createCronSchedule({
      name: payload.name as string,
      schedule: payload.schedule as string,
      jobType: payload.jobType as never,
      enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined,
      description:
        typeof payload.description === "string" ? payload.description : undefined,
    });
    // Apply live: re-arm the daemon so the new schedule starts (or is
    // parked as disabled) without a server restart.
    syncCognitiveDaemon();
    return NextResponse.json({ schedule }, { status: 201 });
  } catch (error) {
    if (error instanceof CronValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    console.error("[api/cron/schedules] POST error:", error);
    return NextResponse.json({ error: "Failed to create schedule" }, { status: 500 });
  }
}

/**
 * PATCH /api/cron/schedules — update one or many fields.
 * Body: { id, name?, schedule?, jobType?, enabled?, description? }
 */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const payload = body as Record<string, unknown>;

  if (typeof payload?.id !== "string" || payload.id.length === 0) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (payload.name !== undefined) patch.name = payload.name;
  if (payload.schedule !== undefined) patch.schedule = payload.schedule;
  if (payload.jobType !== undefined) patch.jobType = payload.jobType;
  if (payload.enabled !== undefined) patch.enabled = payload.enabled;
  if (payload.description !== undefined) patch.description = payload.description;

  try {
    const schedule = await updateCronSchedule(payload.id, patch);
    if (!schedule) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }
    syncCognitiveDaemon();
    return NextResponse.json({ schedule });
  } catch (error) {
    if (error instanceof CronValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    console.error("[api/cron/schedules] PATCH error:", error);
    return NextResponse.json({ error: "Failed to update schedule" }, { status: 500 });
  }
}

/**
 * DELETE /api/cron/schedules?id=cron_... — remove a schedule.
 */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "id query parameter is required" },
      { status: 400 }
    );
  }

  try {
    const removed = deleteCronSchedule(id);
    if (!removed) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }
    syncCognitiveDaemon();
    return NextResponse.json({ deleted: removed });
  } catch (error) {
    console.error("[api/cron/schedules] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to delete schedule" },
      { status: 500 }
    );
  }
}
