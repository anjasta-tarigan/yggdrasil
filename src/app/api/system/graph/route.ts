import { NextResponse } from "next/server";
import { getKnowledgeGraph } from "@/lib/memory/graph";

export const dynamic = "force-dynamic";

/**
 * Knowledge graph (memory nodes + relation edges) for the Statistics
 * page visualization. Query: ?maxNodes= (default 150).
 */
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

  try {
    const graph = await getKnowledgeGraph({ maxNodes });
    return NextResponse.json(graph);
  } catch (error) {
    console.error("[api/system/graph] GET error:", error);
    return NextResponse.json(
      { error: "Failed to build knowledge graph" },
      { status: 500 }
    );
  }
}
