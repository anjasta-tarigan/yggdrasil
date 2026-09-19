import { NextResponse } from "next/server";
import {
  listProjects,
  listProjectsPaginated,
  createProject,
  sanitizeProjectName,
  deleteProjects,
  type PaginatedProjectsResult,
} from "@/lib/project-service";
import { validateProjectApiRequest } from "./guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guardResponse = validateProjectApiRequest(req);
  if (guardResponse) return guardResponse;

  try {
    const url = new URL(req.url);
    const page = url.searchParams.get("page");
    const limit = url.searchParams.get("limit");

    // If pagination params are provided, return paginated response
    if (page !== null || limit !== null) {
      const result: PaginatedProjectsResult = await listProjectsPaginated(
        page ? Number(page) : 1,
        limit ? Number(limit) : 20
      );
      return NextResponse.json(result);
    }

    // Backward-compatible: no pagination params → return flat array
    const projects = await listProjects();
    return NextResponse.json(projects);
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to list projects" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  const guardResponse = validateProjectApiRequest(req, {
    requireJsonBody: true,
  });
  if (guardResponse) return guardResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch (err: unknown) {
    console.warn("[api/projects] DELETE invalid JSON body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;

  if (!Array.isArray(payload.ids)) {
    return NextResponse.json(
      { error: "ids must be an array of project IDs" },
      { status: 400 }
    );
  }

  const ids = payload.ids as unknown[];
  if (ids.some((id) => typeof id !== "string")) {
    return NextResponse.json(
      { error: "All project IDs must be strings" },
      { status: 400 }
    );
  }

  if (ids.length === 0) {
    return NextResponse.json({ success: true, deleted: 0 });
  }

  try {
    await deleteProjects(ids as string[]);
    return NextResponse.json({ success: true, deleted: ids.length });
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to delete projects" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const guardResponse = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guardResponse) return guardResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch (err: unknown) {
    console.warn("[api/projects] POST invalid JSON body:", err);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;

  if (typeof payload.name !== "string" || !payload.name.trim()) {
    return NextResponse.json(
      { error: "Project name is required and must be a non-empty string" },
      { status: 400 }
    );
  }

  if (payload.mode !== "new" && payload.mode !== "existing") {
    return NextResponse.json(
      { error: 'Project mode must be either "new" or "existing"' },
      { status: 400 }
    );
  }

  // Validate project name syntax, path traversal defense, and reserved names
  try {
    sanitizeProjectName(payload.name);
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (payload.mode === "existing") {
    if (typeof payload.directoryPath !== "string" || !payload.directoryPath.trim()) {
      return NextResponse.json(
        { error: 'directoryPath is required for "existing" project mode' },
        { status: 400 }
      );
    }
  }

  try {
    const project = await createProject({
      name: payload.name,
      description:
        typeof payload.description === "string" ? payload.description : null,
      customInstructions:
        typeof payload.customInstructions === "string"
          ? payload.customInstructions
          : null,
      mode: payload.mode,
      directoryPath:
        typeof payload.directoryPath === "string"
          ? payload.directoryPath.trim()
          : undefined,
      customBaseDir:
        typeof payload.customBaseDir === "string"
          ? payload.customBaseDir.trim()
          : undefined,
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to create project" },
      { status: 400 }
    );
  }
}
