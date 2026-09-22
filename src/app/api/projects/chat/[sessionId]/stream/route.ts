import { NextResponse } from "next/server";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { getRun } from "workflow/api";
import { validateProjectApiRequest } from "../../../guard";
import {
  getProjectSession,
  releaseProjectRun,
  releaseProjectSessionStream,
} from "@/lib/project-service";
import { attachStream } from "@/lib/ai/stream-registry";

export const dynamic = "force-dynamic";

/**
 * Reconnect endpoint for the Projects harness.
 *
 * Re-attaches a client to an in-flight generation after a tab switch, reload, or
 * lost socket, so the run is not left apparently dead (which would make the next
 * send fail with 409 forever). Two paths share this endpoint:
 *
 * - Fallback (PROJECT_HARNESS_DURABLE off): the generation lives in the in-process
 *   `streamRegistry` keyed by `activeStreamId`. `attachStream` replays history and
 *   live chunks; a stale pointer (registry evicted the entry) is released.
 * - Durable (flag on): the generation is a Workflow run keyed by `activeRunId`.
 *   `getRun(...).readable` is the live stream; a run that has ended/pruned but
 *   left a lingering pointer is released so the session is reusable (spec §4.5).
 *
 * Both answer 204 when there is nothing to reconnect to, letting the client fall
 * back to its own persisted state.
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const guardResponse = validateProjectApiRequest(req);
  if (guardResponse) return guardResponse;

  const { sessionId } = await context.params;
  let session;
  try {
    session = await getProjectSession(sessionId);
  } catch {
    // DB lookup failed: nothing to reconnect to.
    return new NextResponse(null, { status: 204 });
  }
  if (!session) {
    return new NextResponse(null, { status: 204 });
  }

  // Durable path: re-attach to a Workflow run.
  if (process.env.PROJECT_HARNESS_DURABLE === "true") {
    const runId = session.activeRunId;
    if (!runId) return new NextResponse(null, { status: 204 });

    try {
      const run = getRun(runId);
      const exists = await run.exists;
      if (!exists) {
        releaseProjectRun(sessionId, runId);
        return new NextResponse(null, { status: 204 });
      }
      return createUIMessageStreamResponse({
        stream: run.readable as unknown as ReadableStream<UIMessageChunk>,
      });
    } catch {
      return new NextResponse(null, { status: 204 });
    }
  }

  // Fallback path: re-attach to the in-process stream registry. The registry
  // hands out raw SSE strings, so the response passes them through unchanged.
  const streamId = session.activeStreamId;
  if (!streamId) return new NextResponse(null, { status: 204 });

  const replay = attachStream(streamId);
  if (!replay) {
    // Registry evicted the entry but the pointer lingered: clear it so a later
    // send is not refused with 409.
    releaseProjectSessionStream(sessionId, streamId);
    return new NextResponse(null, { status: 204 });
  }

  return new Response(
    replay.pipeThrough(new TextEncoderStream()),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}
