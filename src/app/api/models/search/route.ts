import { NextResponse } from "next/server";
import { createHfClient } from "@/lib/models/hf-client";
import type { ModelKind } from "@/lib/models/types";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const kind = (searchParams.get("kind") ?? "embedding") as ModelKind;

  if (!q) {
    return NextResponse.json({ error: "Missing query parameter 'q'" }, { status: 400 });
  }

  try {
    const client = createHfClient();
    const results = await client.searchModels(q, kind);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
