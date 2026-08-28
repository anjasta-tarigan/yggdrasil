import { NextResponse } from "next/server";
import { collectSystemStats } from "@/lib/system-stats";

export const dynamic = "force-dynamic";

/**
 * Device information, live resource usage, GPU probe, service endpoint
 * status, cognitive-loop summary and maintenance schedule for the
 * Statistics page. The UI polls this every few seconds.
 */
export async function GET() {
  try {
    const stats = await collectSystemStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[api/system/stats] GET error:", error);
    return NextResponse.json(
      { error: "Failed to collect system stats" },
      { status: 500 }
    );
  }
}
