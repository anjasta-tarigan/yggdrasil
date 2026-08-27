import { NextResponse } from "next/server";
import {
  composeSkillMd,
} from "@/lib/skills/catalog";
import {
  isValidSkillName,
  MAX_SKILL_DESCRIPTION_LENGTH,
  sanitizeSkillFiles,
  type SkillFile,
} from "@/lib/skills/config";
import { installSkill, listSkills } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/** GET /api/skills — installed skills registry. */
export async function GET() {
  try {
    const rows = await listSkills();
    return NextResponse.json({ skills: rows });
  } catch (error) {
    console.error("[api/skills] GET error:", error);
    return NextResponse.json({ error: "Failed to list skills" }, { status: 500 });
  }
}

/**
 * POST /api/skills — create a skill manually (wizard).
 * Body: { name, description, content, files?: [{ path, content }] }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const v = body as Record<string, unknown>;

  const name = typeof v.name === "string" ? v.name.trim() : "";
  const description = typeof v.description === "string" ? v.description.trim() : "";
  const content = typeof v.content === "string" ? v.content : "";

  if (!isValidSkillName(name)) {
    return NextResponse.json(
      {
        error:
          "Invalid skill name. Use lowercase letters, digits and hyphens (max 64 chars, no leading/trailing/consecutive hyphens).",
      },
      { status: 400 }
    );
  }
  if (!description || description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return NextResponse.json(
      { error: `Description is required (max ${MAX_SKILL_DESCRIPTION_LENGTH} chars).` },
      { status: 400 }
    );
  }
  if (!content.trim()) {
    return NextResponse.json(
      { error: "Skill instructions (content) are required." },
      { status: 400 }
    );
  }

  const files: SkillFile[] = [{ path: "SKILL.md", content: composeSkillMd(name, description, content) }];
  if (v.files !== undefined) {
    if (!Array.isArray(v.files) || v.files.length > 99) {
      return NextResponse.json({ error: "files must be an array (max 99)." }, { status: 400 });
    }
    for (const f of v.files) {
      if (
        typeof f !== "object" ||
        f === null ||
        typeof (f as { path?: unknown }).path !== "string" ||
        typeof (f as { content?: unknown }).content !== "string"
      ) {
        return NextResponse.json(
          { error: "Each file needs a string path and string content." },
          { status: 400 }
        );
      }
      const file = f as { path: string; content: string };
      files.push({ path: file.path, content: file.content });
    }
  }

  const check = sanitizeSkillFiles(files);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  try {
    const result = await installSkill({
      name,
      files,
      source: { kind: "local" },
    });
    if (!result.ok) {
      const status = /already exists|does not match/i.test(result.error) ? 409 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ skill: result.row, replaced: result.replaced });
  } catch (error) {
    console.error("[api/skills] POST error:", error);
    return NextResponse.json({ error: "Failed to create skill" }, { status: 500 });
  }
}
