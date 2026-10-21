import { NextResponse } from "next/server";
import { markEventRead } from "@/lib/proactive/events";
import { validateProjectApiRequest } from "@/lib/security/api-guard";

/**
 * Mark a single proactive event as read (inbox item click).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guard) return guard;

  try {
    const { id } = await params;
    const updated = await markEventRead(id);
    if (!updated) {
      return NextResponse.json(
        { error: "Event not found or already read" },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/events/[id]/read] POST error:", error);
    return NextResponse.json({ error: "Failed to update event" }, { status: 500 });
  }
}
