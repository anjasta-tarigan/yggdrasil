import { NextResponse } from "next/server";
import {
  getSkillById,
  listSkillFiles,
  readSkillFile,
} from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills/[id]/files — list bundled files, or read one with
 * ?path=references/notes.md (bounded text preview).
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const row = await getSkillById(id);
    if (!row) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return NextResponse.json({ files: listSkillFiles(row.name) });
    }

    const result = readSkillFile(row.name, path);
    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({ path, ...result });
  } catch (error) {
    console.error("[api/skills/[id]/files] GET error:", error);
    return NextResponse.json({ error: "Failed to read skill files" }, { status: 500 });
  }
}
