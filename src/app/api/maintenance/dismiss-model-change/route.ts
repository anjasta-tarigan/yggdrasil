import { NextResponse } from "next/server";
import { setSettingsDb } from "@/lib/settings-service";
import { syslog } from "@/lib/observability/log-store";

export const dynamic = "force-dynamic";

/**
 * Dismiss the embedding-model-change confirmation prompt without rebuilding.
 * Clears the ephemeral flag so the dialog does not reappear on unrelated
 * setting saves. The user can still trigger a manual rebuild from the
 * Database tab.
 */
export async function POST() {
  try {
    setSettingsDb({ embedding_model_changed: undefined });
    return NextResponse.json({ success: true });
  } catch (error) {
    syslog(
      "error",
      "embed-backfill",
      `Failed to dismiss model change: ${error instanceof Error ? error.message : String(error)}`
    );
    return NextResponse.json(
      { error: "Failed to clear model-change flag" },
      { status: 500 }
    );
  }
}
