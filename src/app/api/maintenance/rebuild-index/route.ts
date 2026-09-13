import { NextResponse } from "next/server";
import { rebuildEmbeddingIndex } from "@/lib/memory/embed-backfill";
import { setSettingsDb } from "@/lib/settings-service";
import { syslog } from "@/lib/observability/log-store";

/**
 * Clear the ephemeral embedding-model-change flag from the settings store.
 * The settings GET handler surfaces it once for the confirmation dialog;
 * once the user acts (rebuild now or dismiss), it is cleared so the prompt
 * does not reappear on unrelated setting saves.
 */
function clearModelChangedFlag(): void {
  setSettingsDb({ embedding_model_changed: undefined });
}

export const dynamic = "force-dynamic";

/**
 * Full re-index pass: null all embeddings across both episodic and semantic
 * memory tables, then re-embed every row under the currently configured model.
 *
 * This is triggered when the user changes the embedding model and confirms
 * the rebuild dialog. The vec index is lazily rebuilt on the next search
 * via syncVectorIndex.
 */
export async function POST() {
  try {
    const result = await rebuildEmbeddingIndex();
    clearModelChangedFlag();
    syslog(
      "info",
      "embed-backfill",
      `rebuildEmbeddingIndex completed: nulled ${result.nulledCount}, embedded ${result.embeddedCount}, remaining ${result.remaining}`
    );
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error(
      "[api/maintenance/rebuild-index] POST error:",
      error
    );
    return NextResponse.json(
      { error: "Embedding index rebuild failed" },
      { status: 500 }
    );
  }
}
