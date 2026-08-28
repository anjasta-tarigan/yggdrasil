/**
 * Next.js instrumentation hook — runs once when the server instance starts,
 * before any request is handled. This is the canonical startup point for
 * the autonomous cognitive system; the chat route still calls bootstrap as
 * an idempotent fallback (e.g. for serverless-style cold paths).
 *
 * The Node.js runtime guard keeps the edge runtime from importing
 * better-sqlite3. The dynamic import defers loading the whole dependency
 * chain until the guard passes.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { bootstrapAutonomousCognitiveSystem } = await import("./lib/bootstrap");
    bootstrapAutonomousCognitiveSystem();
  } catch (err) {
    // A bootstrap failure must not take down the web server — the chat
    // route's fallback will retry on the next request.
    console.error("[instrumentation] Cognitive bootstrap failed:", err);
  }
}
