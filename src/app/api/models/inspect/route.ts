import { NextResponse } from "next/server";
import { createHfClient } from "@/lib/models/hf-client";
import { planInstall } from "@/lib/models/installer";
import type { ModelKind } from "@/lib/models/types";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const repo = body?.repo?.trim();
  const kind = (body?.kind ?? "embedding") as ModelKind;
  const variant = body?.variant?.trim();

  if (!repo) {
    return NextResponse.json({ error: "Missing 'repo' in body" }, { status: 400 });
  }

  try {
    const client = createHfClient();
    const plan = await planInstall({ repo, kind, client, preferredVariant: variant });
    return NextResponse.json({ plan });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
