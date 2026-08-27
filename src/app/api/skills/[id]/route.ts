import { NextResponse } from "next/server";
import {
  getSkillById,
  setSkillEnabled,
  uninstallSkill,
} from "@/lib/skills/store";

export const dynamic = "force-dynamic";

/** PATCH /api/skills/[id] — toggle enablement. Body: { enabled: boolean } */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = body as Record<string, unknown>;
  if (typeof v?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  try {
    const row = await setSkillEnabled(id, v.enabled);
    if (!row) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }
    return NextResponse.json({ skill: row });
  } catch (error) {
    console.error("[api/skills/[id]] PATCH error:", error);
    return NextResponse.json({ error: "Failed to update skill" }, { status: 500 });
  }
}

/** DELETE /api/skills/[id] — uninstall. Plugin-owned skills are protected. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const row = await getSkillById(id);
    if (!row) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }
    if (row.pluginId) {
      return NextResponse.json(
        { error: "This skill belongs to a plugin; uninstall the plugin instead." },
        { status: 409 }
      );
    }
    await uninstallSkill(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/skills/[id]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete skill" }, { status: 500 });
  }
}
