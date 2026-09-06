import { NextResponse } from "next/server";
import { upsertMessageFeedbackDb } from "@/lib/chat-service";

/**
 * PATCH /api/chats/[id]/messages/[messageId]/feedback
 *
 * Persist a thumbs-up/down vote on an individual assistant message.
 * Used for messages that are already settled in the database (historical
 * messages). Messages captured in the current in-flight turn carry their
 * feedback through the normal chat settle path.
 *
 * Body: { feedback: "positive" | "negative" | null }
 * - "positive" / "negative" — set or overwrite the vote
 * - null — clear a previously stored vote
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> }
) {
  const { messageId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;

  // feedback key must be present (undefined = missing = bad request)
  if (!("feedback" in payload)) {
    return NextResponse.json(
      { error: "Missing required field: feedback" },
      { status: 400 }
    );
  }

  const { feedback } = payload;
  if (feedback !== null && feedback !== "positive" && feedback !== "negative") {
    return NextResponse.json(
      { error: "feedback must be 'positive', 'negative', or null" },
      { status: 400 }
    );
  }

  try {
    const ok = await upsertMessageFeedbackDb(
      messageId,
      feedback as "positive" | "negative" | null
    );
    if (!ok) {
      return NextResponse.json({ error: "Message not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(
      "[api/chats/[id]/messages/[messageId]/feedback] PATCH error:",
      error
    );
    return NextResponse.json(
      { error: "Failed to update feedback" },
      { status: 500 }
    );
  }
}
