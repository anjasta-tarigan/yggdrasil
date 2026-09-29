import { NextResponse } from "next/server";
import { runPragmaOptimize, runVacuum } from "@/db/maintenance";

export const dynamic = "force-dynamic";

/**
 * POST /api/maintenance/optimize
 * Body: { vacuum?: boolean }
 *
 * Refresh the query-planner statistics (fast, safe any time) and
 * optionally VACUUM the database file to reclaim free pages (slower;
 * also runs automatically on Sundays inside the decay_sweep pass).
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const vacuum = (body as Record<string, unknown> | null)?.vacuum === true;

  try {
    await runPragmaOptimize();
    if (!vacuum) {
      return NextResponse.json({
        ok: true,
        pragmaOptimize: "completed",
        message: "Query planner statistics updated.",
      });
    }
    const vacuumResult = await runVacuum();
    return NextResponse.json({
      ok: true,
      pragmaOptimize: "completed",
      vacuum: vacuumResult,
      message: `Optimized; VACUUM reclaimed ~${vacuumResult.recoveredBytes} bytes.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/maintenance/optimize] POST error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
