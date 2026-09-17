import { NextResponse } from "next/server";
import { nanoid } from "nanoid";
import {
  getProject,
  listProjectSessions,
  saveProjectSession,
  type StoredProjectSession,
} from "@/lib/project-service";
import { validateProjectApiRequest } from "../../guard";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guardResponse = validateProjectApiRequest(req);
  if (guardResponse) return guardResponse;

  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const sessions = await listProjectSessions(id);
    return NextResponse.json(sessions);
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to list project sessions" },
      { status: 500 }
    );
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guardResponse = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guardResponse) return guardResponse;

  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const title =
    typeof payload.title === "string" && payload.title.trim()
      ? payload.title.trim()
      : "New Session";

  const sessionId = `psess_${Date.now()}_${nanoid()}`;
  const now = Date.now();

  const newSession: StoredProjectSession = {
    id: sessionId,
    projectId: id,
    title,
    pinned: false,
    activeStreamId: null,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };

  try {
    await saveProjectSession(newSession);
    return NextResponse.json(newSession, { status: 201 });
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to create project session" },
      { status: 500 }
    );
  }
}
