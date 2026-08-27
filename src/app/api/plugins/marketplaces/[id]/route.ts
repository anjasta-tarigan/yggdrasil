import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plugins } from "@/db/schema";
import { getMarketplace, removeMarketplace } from "@/lib/plugins/marketplace";
import { uninstallPlugin } from "@/lib/plugins/lifecycle";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/plugins/marketplaces/[id] — unregister a marketplace.
 * Its installed plugins are uninstalled first (file trees, skills,
 * commands and contributed MCP servers are cleaned up).
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const marketplace = getMarketplace(id);
    if (!marketplace) {
      return NextResponse.json({ error: "Marketplace not found" }, { status: 404 });
    }

    const installed = db
      .select({ id: plugins.id })
      .from(plugins)
      .where(eq(plugins.marketplaceId, id))
      .all();
    for (const plugin of installed) {
      await uninstallPlugin(plugin.id);
    }

    removeMarketplace(id);
    return NextResponse.json({ ok: true, removedPlugins: installed.length });
  } catch (error) {
    console.error("[api/plugins/marketplaces/[id]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to remove marketplace" }, { status: 500 });
  }
}
