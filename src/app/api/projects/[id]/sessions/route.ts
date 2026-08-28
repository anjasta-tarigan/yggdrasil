import { NextResponse } from "next/server";
import {
  listProjectSessions,
  saveProjectSession,
  getProject,
} from "@/lib/project-service";
import type { UIMessage } from "ai";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/sessions - List all sessions for a project
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const sessions = await listProjectSessions(id);
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("[api/projects/[id]/sessions] GET error:", error);
    return NextResponse.json(
      { error: "Failed to list project sessions" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/projects/[id]/sessions - Save a project session
 * Body: { sessionId: string, title: string, messages: UIMessage[] }
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, title, messages } = (body as Record<string, unknown>) ?? {};

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    await saveProjectSession({
      id: sessionId.trim(),
      projectId: id,
      title: typeof title === "string" && title.trim() ? title.trim() : "New Session",
      updatedAt: Date.now(),
      createdAt: Date.now(),
      messages: Array.isArray(messages) ? (messages as UIMessage[]) : [],
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/projects/[id]/sessions] POST error:", error);
    return NextResponse.json(
      { error: "Failed to save project session" },
      { status: 500 }
    );
  }
}
