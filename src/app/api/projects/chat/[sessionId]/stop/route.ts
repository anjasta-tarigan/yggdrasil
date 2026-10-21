import { NextResponse } from "next/server";
import { validateProjectApiRequest } from "../../../guard";
import { getProjectSession } from "@/lib/project-service";
import { streamRegistry } from "@/lib/ai/stream-registry";
import { cancelProjectRuns } from "@/lib/project-run-lifecycle";

export async function POST(
  req: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const guardResponse = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guardResponse) return guardResponse;

  const { sessionId } = await context.params;
  const session = await getProjectSession(sessionId);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  if (session.activeStreamId) streamRegistry.abort(session.activeStreamId);
  await cancelProjectRuns([session]);
  return NextResponse.json({ success: true });
}
