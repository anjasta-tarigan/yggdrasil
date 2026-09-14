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
export async function POST(req?: Request) {
  const isStream = Boolean(
    req?.headers?.get("accept")?.includes("text/event-stream") ||
      req?.url?.includes("stream=true")
  );

  if (!isStream) {
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
      syslog(
        "error",
        "embed-backfill",
        `rebuildEmbeddingIndex failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return NextResponse.json(
        { error: "Embedding index rebuild failed" },
        { status: 500 }
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // Client disconnected
        }
      };

      try {
        const result = await rebuildEmbeddingIndex({
          onProgress: (current, total) => {
            sendEvent({ type: "progress", current, total });
          },
        });
        clearModelChangedFlag();
        syslog(
          "info",
          "embed-backfill",
          `rebuildEmbeddingIndex completed: nulled ${result.nulledCount}, embedded ${result.embeddedCount}, remaining ${result.remaining}`
        );
        sendEvent({ type: "complete", success: true, ...result });
        try {
          controller.close();
        } catch {
          // Client already disconnected
        }
      } catch (error) {
        syslog(
          "error",
          "embed-backfill",
          `rebuildEmbeddingIndex failed: ${error instanceof Error ? error.message : String(error)}`
        );
        sendEvent({
          type: "error",
          error: error instanceof Error ? error.message : "Embedding index rebuild failed",
        });
        try {
          controller.close();
        } catch {
          // Client already disconnected
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
