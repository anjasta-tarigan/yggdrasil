import { NextResponse } from "next/server";
import {
  getProject,
  setProjectTrusted,
  deleteProject,
  listProjectSessions,
} from "@/lib/project-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id] - Get project details and sessions
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const project = await getProject(id);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const sessions = await listProjectSessions(id);
    return NextResponse.json({ project, sessions });
  } catch (error) {
    console.error("[api/projects/[id]] GET error:", error);
    return NextResponse.json(
      { error: "Failed to load project details" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/projects/[id] - Update trusted status or settings
 * Body: { trusted?: boolean }
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { trusted } = (body as Record<string, unknown>) ?? {};

  if (typeof trusted !== "boolean") {
    return NextResponse.json(
      { error: "trusted boolean parameter is required" },
      { status: 400 }
    );
  }

  try {
    const updated = await setProjectTrusted(id, trusted);
    if (!updated) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ project: updated });
  } catch (error) {
    console.error("[api/projects/[id]] PATCH error:", error);
    return NextResponse.json(
      { error: "Failed to update project" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/projects/[id] - Delete project
 */
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    await deleteProject(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[api/projects/[id]] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to delete project" },
      { status: 500 }
    );
  }
}
