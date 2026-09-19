import {
  clearActiveStreamIdDb,
  getActiveStreamIdDb,
  saveChatDb,
} from "@/lib/chat-service";
import { cancelStream } from "@/lib/ai/stream-registry";
import { deriveTitle } from "@/lib/chat-storage";
import type { UIMessage } from "ai";

/**
 * Explicit-stop endpoint (resumable-stream contract). With resume
 * enabled, the client's `stop()` is only a *disconnect* — the server
 * keeps generating so it can be re-attached later. A genuine stop
 * must come here: persist the client's partial assistant message,
 * cancel the server-side generation, and clear the active pointer.
 *
 * `activeStreamId` in the body (when present) must match the stored
 * pointer, or the stop is ignored — a stale stop must not cancel a
 * NEWER stream that started while the stop request was in flight.
 */
type StopRequest = {
  activeStreamId?: string | null;
  assistantMessage?: UIMessage;
};

function isUIMessageShape(value: unknown): value is UIMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant" || m.role === "system") &&
    Array.isArray(m.parts)
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const body = (await req.json().catch(() => ({}))) as StopRequest;
  const requestedStreamId =
    typeof body?.activeStreamId === "string" ? body.activeStreamId : null;

  let activeStreamId: string | null = null;
  try {
    activeStreamId = await getActiveStreamIdDb(id);
  } catch (error) {
    console.error("[api/chat/[id]/stop] pointer lookup failed:", error);
    return Response.json(
      { success: false, error: "Failed to read chat state" },
      { status: 500 }
    );
  }

  if (activeStreamId == null) {
    // No live generation (normal when the user stops a stream that
    // already finished, or the app restarted mid-run).
    return Response.json({ success: true, stopped: false });
  }

  // Stale-stop guard: a stop naming an older stream must not cancel a
  // newer one that replaced it.
  if (requestedStreamId != null && requestedStreamId !== activeStreamId) {
    return Response.json({ success: true, stopped: false, stale: true });
  }

  // Persist the client's partial assistant message BEFORE canceling,
  // so the user keeps whatever was generated up to the stop. This is
  // an insert-or-replace of one message inside the chat's saved set —
  // the client sends its current view of the assistant message.
  if (body?.assistantMessage && isUIMessageShape(body.assistantMessage)) {
    try {
      // Load current persisted list to merge the partial into it; a
      // blind replace could drop messages that arrived after the
      // client's snapshot.
      const { getChatDb } = await import("@/lib/chat-service");
      const chat = await getChatDb(id);
      const persisted = chat?.messages ?? [];
      const snapshot = body.assistantMessage;
      const existingIdx = persisted.findIndex((m) => m.id === snapshot.id);
      const merged =
        existingIdx >= 0
          ? persisted.map((m, i) => (i === existingIdx ? snapshot : m))
          : [...persisted, snapshot];
      await saveChatDb({
        id,
        title: chat?.title ?? deriveTitle(merged),
        updatedAt: Date.now(),
        messages: merged,
      });
    } catch (err) {
      console.warn("[api/chat/[id]/stop] partial save failed:", err);
    }
  }

  const wasLive = cancelStream(activeStreamId);
  // Clear the pointer only if it still names the stream we just
  // stopped (a newer stream may have started since the lookup).
  await clearActiveStreamIdDb(id, activeStreamId).catch((err) =>
    console.warn("[stop] Failed to clear active stream id from DB:", err)
  );

  return Response.json({ success: true, stopped: wasLive });
}
