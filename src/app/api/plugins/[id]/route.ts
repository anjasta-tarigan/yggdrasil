import { NextResponse } from "next/server";
import { setPluginEnabled, uninstallPlugin } from "@/lib/plugins/lifecycle";

export const dynamic = "force-dynamic";

/** PATCH /api/plugins/[id] — toggle enablement. Body: { enabled: boolean } */
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
    const row = setPluginEnabled(id, v.enabled);
    if (!row) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    return NextResponse.json({ plugin: row });
  } catch (error) {
    console.error("[api/plugins/[id]] PATCH error:", error);
    return NextResponse.json({ error: "Failed to update plugin" }, { status: 500 });
  }
}

/** DELETE /api/plugins/[id] — uninstall (tree, skills, commands, MCP entries). */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const removed = await uninstallPlugin(id);
    if (!removed) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/plugins/[id]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to uninstall plugin" }, { status: 500 });
  }
}
