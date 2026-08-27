import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { plugins } from "@/db/schema";
import { parseGithubRepoRef } from "@/lib/skills/registries/github";
import {
  fetchMarketplaceManifest,
  getMarketplace,
  type MarketplaceSource,
  type PluginSourceSpec,
} from "@/lib/plugins/marketplace";

export const dynamic = "force-dynamic";

/** Whether this build can install the given plugin source type. */
function isSupportedSource(source: PluginSourceSpec): boolean {
  if (typeof source === "string") return source.startsWith("./");
  switch (source.source) {
    case "github":
    case "archive":
      return true;
    case "git-subdir":
    case "url": {
      return Boolean(parseGithubRepoRef(source.url ?? ""));
    }
    default:
      return false;
  }
}

/**
 * GET /api/plugins/catalog?marketplace=<id> — fresh manifest entries
 * joined with local install state.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const marketplaceId = url.searchParams.get("marketplace") ?? "";
  if (!marketplaceId) {
    return NextResponse.json({ error: "marketplace param is required" }, { status: 400 });
  }

  const marketplace = getMarketplace(marketplaceId);
  if (!marketplace) {
    return NextResponse.json({ error: "Marketplace not found" }, { status: 404 });
  }

  try {
    const manifest = await fetchMarketplaceManifest(
      marketplace.source as unknown as MarketplaceSource
    );
    const installed = db
      .select()
      .from(plugins)
      .where(eq(plugins.marketplaceId, marketplaceId))
      .all();
    const installedByName = new Map(installed.map((p) => [p.name, p]));

    const entries = manifest.plugins.map((entry) => {
      const local = installedByName.get(entry.name);
      const sourceType =
        typeof entry.source === "string"
          ? "path"
          : ((entry.source as { source?: string }).source ?? "unknown");
      return {
        name: entry.name,
        displayName: entry.displayName,
        description: entry.description,
        version: entry.version,
        category: entry.category,
        author: entry.author?.name,
        sourceType,
        supported: isSupportedSource(entry.source),
        installed: Boolean(local),
        installedId: local?.id,
        enabled: local?.enabled ?? false,
        installedVersion: local?.version,
      };
    });

    return NextResponse.json({
      marketplace: {
        id: marketplace.id,
        name: manifest.name,
        description: manifest.description,
        owner: manifest.owner?.name,
      },
      entries,
    });
  } catch (error) {
    console.error("[api/plugins/catalog] GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch catalog" },
      { status: 502 }
    );
  }
}
