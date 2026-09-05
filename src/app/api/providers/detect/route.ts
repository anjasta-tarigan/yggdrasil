import { NextResponse } from "next/server";
import { detectCapabilities } from "@/lib/ai/capability-detection";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    typeof body.providerId !== "string" ||
    !body.providerId.trim() ||
    typeof body.modelId !== "string" ||
    !body.modelId.trim()
  ) {
    return NextResponse.json(
      { error: "providerId and modelId are required" },
      { status: 400 },
    );
  }

  try {
    const result = await detectCapabilities({
      providerId: body.providerId.trim(),
      modelId: body.modelId.trim(),
      force: Boolean(body.force),
    });

    return NextResponse.json(result);
  } catch (err: any) {
    if (err?.message?.includes("not found")) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("[api/providers/detect] Detection error:", err);
    return NextResponse.json(
      { error: "Capability detection failed" },
      { status: 500 },
    );
  }
}
