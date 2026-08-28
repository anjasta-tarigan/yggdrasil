import { NextResponse } from "next/server";
import {
  listProjects,
  createProject,
} from "@/lib/project-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects - List all registered projects
 */
export async function GET() {
  try {
    const projects = await listProjects();
    return NextResponse.json({ projects });
  } catch (error) {
    console.error("[api/projects] GET error:", error);
    return NextResponse.json(
      { error: "Failed to list projects" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/projects - Create or register a new project directory
 * Body: { name: string, directoryPath: string, description?: string, customInstructions?: string, trusted?: boolean }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, directoryPath, description, customInstructions, trusted, mode } =
    (body as Record<string, unknown>) ?? {};

  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Project name is required" }, { status: 400 });
  }

  if (mode === "existing" && (typeof directoryPath !== "string" || !directoryPath.trim())) {
    return NextResponse.json(
      { error: "Project directory path is required for existing projects" },
      { status: 400 }
    );
  }

  try {
    const project = await createProject({
      name: name.trim(),
      directoryPath: typeof directoryPath === "string" && directoryPath.trim() ? directoryPath.trim() : undefined,
      description: typeof description === "string" ? description : undefined,
      customInstructions:
        typeof customInstructions === "string" ? customInstructions : undefined,
      trusted: Boolean(trusted),
      mode: mode === "existing" ? "existing" : "new",
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    console.error("[api/projects] POST error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create project" },
      { status: 500 }
    );
  }
}
