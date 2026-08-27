import { NextResponse } from "next/server";
import {
  addMarketplace,
  countInstalledPlugins,
  listMarketplaces,
  seedOfficialMarketplace,
} from "@/lib/plugins/marketplace";

export const dynamic = "force-dynamic";

/** GET /api/plugins/marketplaces — registered marketplaces (official seeded). */
export async function GET() {
  try {
    seedOfficialMarketplace();
    const rows = listMarketplaces().map((row) => ({
      ...row,
      installedCount: countInstalledPlugins(row.id),
    }));
    return NextResponse.json({ marketplaces: rows });
  } catch (error) {
    console.error("[api/plugins/marketplaces] GET error:", error);
    return NextResponse.json({ error: "Failed to list marketplaces" }, { status: 500 });
  }
}

/** POST /api/plugins/marketplaces — add by GitHub repo/URL. Body: { source } */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = body as Record<string, unknown>;
  const source = typeof v?.source === "string" ? v.source.trim() : "";
  if (!source || source.length > 512) {
    return NextResponse.json(
      { error: "source is required (GitHub 'owner/repo' or URL)." },
      { status: 400 }
    );
  }
  try {
    const result = await addMarketplace(source);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({
      marketplace: { ...result.row, installedCount: 0 },
      pluginCount: result.manifest.plugins.length,
      replaced: result.replaced,
    });
  } catch (error) {
    console.error("[api/plugins/marketplaces] POST error:", error);
    return NextResponse.json({ error: "Failed to add marketplace" }, { status: 500 });
  }
}
