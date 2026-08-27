import { NextResponse } from "next/server";
import { installPlugin } from "@/lib/plugins/lifecycle";

export const dynamic = "force-dynamic";

/**
 * POST /api/plugins/install — install one plugin from a registered
 * marketplace. Body: { marketplaceId, pluginName }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = body as Record<string, unknown>;
  const marketplaceId =
    typeof v?.marketplaceId === "string" ? v.marketplaceId.trim() : "";
  const pluginName = typeof v?.pluginName === "string" ? v.pluginName.trim() : "";
  if (!marketplaceId || !pluginName || pluginName.length > 100) {
    return NextResponse.json(
      { error: "marketplaceId and pluginName are required." },
      { status: 400 }
    );
  }

  try {
    const result = await installPlugin(marketplaceId, pluginName);
    if (!result.ok) {
      const status = result.unsupported ? 422 : 502;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({
      plugin: result.row,
      components: result.components,
      fileCount: result.fileCount,
      replaced: result.replaced,
    });
  } catch (error) {
    console.error("[api/plugins/install] POST error:", error);
    return NextResponse.json({ error: "Plugin installation failed" }, { status: 500 });
  }
}
