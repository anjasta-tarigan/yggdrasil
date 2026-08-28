import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { getProject, validateAndResolveProjectPath } from "@/lib/project-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/projects/[id]/file?path=relative/path/to/file.ts
 */
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");

  if (!filePath || !filePath.trim()) {
    return NextResponse.json({ error: "path parameter is required" }, { status: 400 });
  }

  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const resolved = validateAndResolveProjectPath(project.directoryPath, filePath);
    const content = await fs.readFile(resolved, "utf8");
    return NextResponse.json({ path: filePath, content });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read file" },
      { status: 500 }
    );
  }
}
