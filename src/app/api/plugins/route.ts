import { NextResponse } from "next/server";
import { listPlugins } from "@/lib/plugins/lifecycle";
import { listMarketplaces } from "@/lib/plugins/marketplace";

export const dynamic = "force-dynamic";

/** GET /api/plugins — installed plugins with marketplace names. */
export async function GET() {
  try {
    const marketplaces = new Map(
      listMarketplaces().map((m) => [m.id, m.name])
    );
    const rows = listPlugins().map((row) => ({
      ...row,
      marketplaceName: marketplaces.get(row.marketplaceId) ?? "unknown",
    }));
    return NextResponse.json({ plugins: rows });
  } catch (error) {
    console.error("[api/plugins] GET error:", error);
    return NextResponse.json({ error: "Failed to list plugins" }, { status: 500 });
  }
}
