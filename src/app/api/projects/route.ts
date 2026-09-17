import { NextResponse } from "next/server";
import {
  listProjects,
  createProject,
  sanitizeProjectName,
} from "@/lib/project-service";
import { validateProjectApiRequest } from "./guard";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guardResponse = validateProjectApiRequest(req);
  if (guardResponse) return guardResponse;

  try {
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

export async function POST(req: Request) {
  const guardResponse = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guardResponse) return guardResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
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
