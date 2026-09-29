import { NextResponse } from "next/server";
import {
  isBusyError,
  resetDatabase,
  totalRecordsDeleted,
} from "@/db/maintenance";

export const dynamic = "force-dynamic";

/**
 * POST /api/maintenance/reset
 *
 * Permanently delete all conversation, memory, project-session and queue
 * data. Settings, API keys, plugins, skills and cron schedules are
 * preserved; project rows are kept but distrusted.
 */
export async function POST() {
  try {
    const deleted = await resetDatabase();
    const totalDeleted = totalRecordsDeleted(deleted);
    return NextResponse.json({
      ok: true,
      deleted,
      message: `Database reset: ${totalDeleted} records deleted.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isBusyError(err)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Database is busy — the queue runner may be mid-write. Try again in a few seconds.",
          code: "DB_LOCKED",
        },
        { status: 409 }
      );
    }
    console.error("[api/maintenance/reset] POST error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
