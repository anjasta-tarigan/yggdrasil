import { NextResponse } from "next/server";
import { createHfClient } from "@/lib/models/hf-client";
import type { ModelKind } from "@/lib/models/types";

const MAX_LIMIT = 200;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // `q` is optional: without it this browses the ranked ONNX catalog so the
  // market is populated on open instead of only after a typed query.
  const q = searchParams.get("q")?.trim() ?? "";
  const kind = (searchParams.get("kind") ?? "embedding") as ModelKind;

  if (kind !== "embedding" && kind !== "reranker") {
    return NextResponse.json({ error: `Invalid kind: ${kind}` }, { status: 400 });
  }

  const rawLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : undefined;

  try {
    const client = createHfClient();
    const results = await client.searchModels({ query: q, kind, limit });
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
