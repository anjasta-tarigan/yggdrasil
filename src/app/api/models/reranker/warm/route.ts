import { NextResponse } from "next/server";
import { warmRerankerSession } from "@/lib/memory/reranker";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const warmed = await warmRerankerSession();
    return NextResponse.json({ success: true, warmed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
