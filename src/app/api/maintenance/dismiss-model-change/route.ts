import { NextResponse } from "next/server";
import { setSettingsDb } from "@/lib/settings-service";

export const dynamic = "force-dynamic";

/**
 * Dismiss the embedding-model-change confirmation prompt without rebuilding.
 * Clears the ephemeral flag so the dialog does not reappear on unrelated
 * setting saves. The user can still trigger a manual rebuild from the
 * Database tab.
 */
export async function POST() {
  setSettingsDb({ embedding_model_changed: undefined });
  return NextResponse.json({ success: true });
}
