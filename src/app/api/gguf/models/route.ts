import { NextResponse } from "next/server";

import { scanGgufModels } from "@/lib/llama/detect";

/**
 * GET /api/gguf/models
 *
 * Scans the GGUF model directory and returns the list of discovered .gguf
 * files, each flagged with whether it fits in currently-available memory.
 *
 * Any throw (directory missing, permission error, etc.) is logged but never
 * leaked to the client — the UI gets an empty list with a debug message.
 * This mirrors ollama/route.ts: server-side probe failures degrade
 * gracefully rather than crashing the Settings page.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const models = await scanGgufModels();
    return NextResponse.json({ models });
  } catch (err) {
    // Non-fatal: the scan dir may not exist yet (user hasn't placed models).
    // Log for diagnostics, return empty so the UI can prompt accordingly.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { models: [], error: message },
      { status: 200 },
    );
  }
}
