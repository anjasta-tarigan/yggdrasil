import { NextResponse } from "next/server";
import { z } from "zod";
import {
  detectCapabilities,
  ProviderNotFoundError,
  WebSessionDetectionUnsupportedError,
} from "@/lib/ai/capability-detection";

export const dynamic = "force-dynamic";

const DetectRequestSchema = z.object({
  providerId: z.string().trim().min(1, "providerId is required"),
  modelId: z.string().trim().min(1, "modelId is required"),
  force: z.boolean().optional().default(false),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Strip unknown fields (OWASP A08) rather than rejecting them.
  const parsed = DetectRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request body" },
      { status: 400 },
    );
  }

  try {
    const result = await detectCapabilities(parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProviderNotFoundError) {
      // Typed dispatch, not a message-substring match (Rule 02).
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof WebSessionDetectionUnsupportedError) {
      // A web-session provider must never reach an unpinned provider origin.
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[api/providers/detect] Detection error:", err);
    return NextResponse.json(
      { error: "Capability detection failed" },
      { status: 500 },
    );
  }
}
