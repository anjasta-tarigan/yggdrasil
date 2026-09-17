import { NextResponse } from "next/server";
import {
  getProject,
  updateProject,
  deleteProject,
  listProjectSessions,
  sanitizeProjectName,
} from "@/lib/project-service";
import { cancelStream } from "@/lib/ai/stream-registry";
import { validateProjectApiRequest } from "../guard";

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

  return NextResponse.json(project);
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guardResponse = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guardResponse) return guardResponse;

  const { id } = await context.params;
  const existing = await getProject(id);
  if (!existing) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

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
  const updates: {
    name?: string;
    description?: string | null;
    customInstructions?: string | null;
  } = {};

  if (payload.name !== undefined) {
    if (typeof payload.name !== "string" || !payload.name.trim()) {
      return NextResponse.json(
        { error: "Name must be a non-empty string" },
        { status: 400 }
      );
    }
    try {
      sanitizeProjectName(payload.name);
    } catch (err: unknown) {
      const error = err as Error;
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    updates.name = payload.name;
  }

  if (payload.description !== undefined) {
    if (payload.description !== null && typeof payload.description !== "string") {
      return NextResponse.json(
        { error: "Description must be a string or null" },
        { status: 400 }
      );
    }
    updates.description = payload.description;
  }

  if (payload.customInstructions !== undefined) {
    if (
      payload.customInstructions !== null &&
      typeof payload.customInstructions !== "string"
    ) {
      return NextResponse.json(
        { error: "customInstructions must be a string or null" },
        { status: 400 }
      );
    }
    updates.customInstructions = payload.customInstructions;
  }

  try {
    const updated = await updateProject(id, updates);
    return NextResponse.json(updated);
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to update project" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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
    // Abort active streams on project sessions before cascading deletion
    const sessions = await listProjectSessions(id);
    for (const session of sessions) {
      if (session.activeStreamId) {
        cancelStream(session.activeStreamId);
      }
    }

    await deleteProject(id);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to delete project" },
      { status: 500 }
    );
  }
}
