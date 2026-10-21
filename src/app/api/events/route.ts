import { NextResponse } from "next/server";
import {
  listUnreadEvents,
  markAllEventsRead,
} from "@/lib/proactive/events";
import { validateProjectApiRequest } from "@/lib/security/api-guard";

export const dynamic = "force-dynamic";

/**
 * Unread proactive events (reminders, briefings) for the header inbox.
 * The client polls this endpoint; events are created server-side by the
 * `scheduled_reminder` job handler.
 */
export async function GET(req: Request) {
  const guard = validateProjectApiRequest(req);
  if (guard) return guard;

  try {
    const events = await listUnreadEvents();
    return NextResponse.json({ events });
  } catch (error) {
    console.error("[api/events] GET error:", error);
    return NextResponse.json({ error: "Failed to load events" }, { status: 500 });
  }
}

/**
 * Mark every unread event as read. Body is ignored; called by the inbox
 * "mark all read" action.
 */
export async function POST(req: Request) {
  const guard = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guard) return guard;

  try {
    const markedRead = await markAllEventsRead();
    return NextResponse.json({ success: true, markedRead });
  } catch (error) {
    console.error("[api/events] POST error:", error);
    return NextResponse.json({ error: "Failed to update events" }, { status: 500 });
  }
}
