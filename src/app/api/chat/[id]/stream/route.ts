import { getActiveStreamIdDb } from "@/lib/chat-service";
import { attachStream } from "@/lib/ai/stream-registry";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";

/**
 * Resume endpoint for ongoing chat generations (resumable-stream
 * contract; the useChat `resume` option GETs here on mount).
 *
 * 204 No Content → no active stream for the chat: the client falls
 * back to its persisted messages (the normal, idle case).
 * 200 + UI message stream → re-attach to the still-running
 * generation; the client continues rendering where it left off.
 */
export async function GET(
  _: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let activeStreamId: string | null = null;
  try {
    activeStreamId = await getActiveStreamIdDb(id);
  } catch (error) {
    console.error("[api/chat/[id]/stream] lookup failed:", error);
    // Unreadable pointer = treat as idle; the client must still boot.
    return new Response(null, { status: 204 });
  }

  if (activeStreamId == null) return new Response(null, { status: 204 });

  const stream = attachStream(activeStreamId);
  if (stream == null) {
    // Stale pointer: the generation finished between the DB read and
    // the registry lookup (or was evicted). Clear it so future GETs
    // fast-path to 204, and answer idle.
    void (async () => {
      try {
        const { clearActiveStreamIdDb } = await import("@/lib/chat-service");
        await clearActiveStreamIdDb(id, activeStreamId);
      } catch {
        // non-fatal: next GET repeats this cleanup
      }
    })();
    return new Response(null, { status: 204 });
  }

  // The registry hands out SSE *string* chunks; a Response body needs
  // bytes. Encode per chunk without re-chunking (SSE framing stays
  // exactly as the original response emitted it).
  const encoder = new TextEncoder();
  const body = stream.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(chunk));
      },
    })
  );

  return new Response(body, { headers: UI_MESSAGE_STREAM_HEADERS });
}

