import { NextResponse } from "next/server";
import { getKnowledgeGraph, type GraphFilters } from "@/lib/memory/graph";

export const dynamic = "force-dynamic";

/**
 * Knowledge graph (memory nodes + relation edges) for the Statistics
 * page visualization.
 *
 * Query params:
 *   maxNodes  — integer 10..500 (default 150)
 *   relationTypes — comma-separated relation types to keep (default all)
 *   nodeTypes — comma-separated node types: semantic, episodic
 *   search    — case-insensitive label/tag substring; a hit keeps its
 *               direct neighbors too
 */
function parseCsv(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawMax = url.searchParams.get("maxNodes");
  const maxNodes = rawMax ? Number(rawMax) : undefined;
  if (
    maxNodes !== undefined &&
    (!Number.isInteger(maxNodes) || maxNodes < 10 || maxNodes > 500)
  ) {
    return NextResponse.json(
      { error: "maxNodes must be an integer between 10 and 500" },
      { status: 400 }
    );
  }

  const relationTypes = parseCsv(url.searchParams.get("relationTypes"));
  const nodeTypeRaw = parseCsv(url.searchParams.get("nodeTypes"));
  const search = url.searchParams.get("search") ?? "";

  const nodeTypes = nodeTypeRaw.filter(
    (t): t is "semantic" | "episodic" => t === "semantic" || t === "episodic"
  );
  if (nodeTypeRaw.length !== nodeTypes.length) {
    return NextResponse.json(
      { error: "nodeTypes values must be 'semantic' or 'episodic'" },
      { status: 400 }
    );
  }

  const filters: GraphFilters = {};
  if (relationTypes.length > 0) filters.relationTypes = relationTypes;
  if (nodeTypes.length > 0) filters.nodeTypes = nodeTypes;
  if (search.trim()) filters.search = search;

  try {
    const graph = await getKnowledgeGraph({ maxNodes, filters });
    return NextResponse.json(graph);
  } catch (error) {
    console.error("[api/system/graph] GET error:", error);
    return NextResponse.json(
      { error: "Failed to build knowledge graph" },
      { status: 500 }
    );
  }
}
