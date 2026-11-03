import { NextResponse } from "next/server";
import { warmRerankerSession } from "@/lib/memory/reranker";
import { safeErrorMessage } from "@/lib/api/safe-error";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const warmed = await warmRerankerSession();
    return NextResponse.json({ success: true, warmed });
  } catch (err) {
    console.error("[api/models/reranker/warm] POST error:", err);
    return NextResponse.json(
      { error: safeErrorMessage(err) },
      { status: 500 }
    );
  }
}
