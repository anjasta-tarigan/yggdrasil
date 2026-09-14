import { NextResponse } from "next/server";
import { z } from "zod";
import { createHfClient } from "@/lib/models/hf-client";
import { planInstall } from "@/lib/models/installer";

const InspectSchema = z.object({
  repo: z.string().trim().min(1).max(256),
  kind: z.enum(["embedding", "reranker"]).default("embedding"),
  variant: z.string().trim().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = InspectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { repo, kind, variant } = parsed.data;

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
