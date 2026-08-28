import { NextResponse } from "next/server";
import { runEmbeddingBackfill } from "@/lib/memory/embed-backfill";

export const dynamic = "force-dynamic";

/**
 * Run an immediate embedding backfill pass (bounded batch) for memories
 * written while the embedding endpoint was down. Runs inline — it only
 * calls the embedding endpoint up to `limit` times — and returns the
 * result so the settings UI can report progress.
 */
export async function POST() {
  try {
    const result = await runEmbeddingBackfill({});
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("[api/maintenance/backfill] POST error:", error);
    return NextResponse.json(
      { error: "Embedding backfill failed" },
      { status: 500 }
    );
  }
}
