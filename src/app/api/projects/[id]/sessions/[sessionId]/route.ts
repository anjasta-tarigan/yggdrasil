import { NextResponse } from "next/server";
import {
  getProjectSession,
  deleteProjectSession,
} from "@/lib/project-service";
import { streamRegistry } from "@/lib/ai/stream-registry";
import { validateProjectApiRequest } from "../../../guard";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string; sessionId: string }> }
) {
  const guardResponse = validateProjectApiRequest(req);
  if (guardResponse) return guardResponse;

  const { id, sessionId } = await context.params;
  const session = await getProjectSession(sessionId);
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(session);
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string; sessionId: string }> }
) {
  const guardResponse = validateProjectApiRequest(req);
  if (guardResponse) return guardResponse;

  const { id, sessionId } = await context.params;
  const session = await getProjectSession(sessionId);
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    // Abort active LLM stream if currently running (Spec §3.8 / §6.2)
    if (session.activeStreamId) {
      streamRegistry.abort(session.activeStreamId);
    }

    await deleteProjectSession(sessionId);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to delete project session" },
      { status: 500 }
    );
  }
}
