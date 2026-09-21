import {
  getProjectSession,
  releaseProjectSessionStream,
} from "@/lib/project-service";
import { attachStream, streamRegistry } from "@/lib/ai/stream-registry";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import type { NextRequest } from "next/server";

/**
 * Resume endpoint for an ongoing Projects harness run (resumable-stream
 * contract; the client's `resume` option GETs here on mount).
 *
 * The Projects route already publishes its SSE stream to the registry
 * (`publishStream` in `api/projects/chat/route.ts`), so a client that lost the
 * connection — tab switched away, page reloaded, browser backgrounded — can
 * re-attach instead of the run appearing dead. Without this endpoint the
 * published stream was unreachable, and a later send hit
 * "Session stream is already in progress" until the registry entry expired.
 *
 * 204 No Content → nothing is running: the client falls back to its persisted
 * messages (the normal, idle case).
 * 200 + UI message stream → re-attach to the still-running generation.
 */
export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  let activeStreamId: string | null = null;
  try {
    const session = await getProjectSession(sessionId);
    activeStreamId = session?.activeStreamId ?? null;
  } catch (error) {
    console.error("[api/projects/chat/[sessionId]/stream] lookup failed:", error);
    // Unreadable pointer = treat as idle; the client must still boot.
    return new Response(null, { status: 204 });
  }

  if (activeStreamId == null) return new Response(null, { status: 204 });

  const stream = attachStream(activeStreamId);
  if (stream == null) {
    // Stale pointer: the run finished between the DB read and the registry
    // lookup (or the entry was evicted). Clear it so future GETs fast-path to
    // 204 and a new send is not refused with 409, then answer idle.
    try {
      releaseProjectSessionStream(sessionId, activeStreamId);
    } catch (error) {
      console.error(
        "[api/projects/chat/[sessionId]/stream] stale-pointer cleanup failed:",
        error
      );
    }
    return new Response(null, { status: 204 });
  }

  // The registry hands out SSE *string* chunks; a Response body needs bytes.
  // Encode per chunk without re-chunking, so the SSE framing stays exactly as
  // the original response emitted it.
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

/** Exposed for tests: whether the registry still knows this stream. */
export function isStreamLive(streamId: string): boolean {
  return streamRegistry.has(streamId);
}
