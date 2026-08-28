import { NextResponse } from "next/server";
import {
  triggerMaintenancePass,
  type MaintenancePass,
} from "@/lib/daemon/scheduler";

export const dynamic = "force-dynamic";

const VALID_PASSES: MaintenancePass[] = [
  "light_sleep",
  "dream_cycle",
  "decay_sweep",
];

/**
 * Manually enqueue a cognitive maintenance pass (runs via the durable job
 * queue, so it respects the active-chat GPU mutex like scheduled passes).
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
  if (typeof pass !== "string" || !VALID_PASSES.includes(pass as MaintenancePass)) {
    return NextResponse.json(
      { error: `pass must be one of: ${VALID_PASSES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const jobId = await triggerMaintenancePass(pass as MaintenancePass);
    return NextResponse.json({ success: true, jobId });
  } catch (error) {
    console.error("[api/maintenance] POST error:", error);
    return NextResponse.json(
      { error: "Failed to enqueue maintenance pass" },
      { status: 500 }
    );
  }
}
