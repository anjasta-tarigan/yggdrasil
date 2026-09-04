/**
 * Next.js instrumentation hook — runs once when the server instance starts,
 * before any request is handled. This is the canonical startup point for
 * the autonomous cognitive system; the chat route still calls bootstrap as
 * an idempotent fallback (e.g. for serverless-style cold paths).
 *
 * Two responsibilities:
 *   1. Install the global observability layer (console capture + crash
 *      hooks) BEFORE anything else logs, so every subsystem's console
 *      output lands in the structured log store.
 *   2. Bootstrap the autonomous cognitive system.
 *
 * IMPORTANT: this file is bundled for the Edge runtime as well as Node.
 * Server-only modules (node:fs, better-sqlite3, …) must only be imported
 * DYNAMICALLY inside the runtime guards — never statically at the top.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { installGlobalCapture } = await import("./lib/observability/capture");
    installGlobalCapture();
  } catch (err) {
    // Capture must never block startup; fall back to raw console.
    console.error("[instrumentation] Log capture install failed:", err);
  }

  try {
    const { bootstrapAutonomousCognitiveSystem } = await import("./lib/bootstrap");
    bootstrapAutonomousCognitiveSystem();
  } catch (err) {
    // A bootstrap failure must not take down the web server — the chat
    // route's fallback will retry on the next request.
    console.error("[instrumentation] Cognitive bootstrap failed:", err);
  }

  try {
    // Best-effort provider-config migration (env + SQLite → JSON + secrets).
    const { ensureMigrated } = await import("./lib/ai/provider-config/migrate");
    await ensureMigrated();
  } catch (err) {
    // Migration must never crash boot; it retries on the next attempt.
    console.error("[instrumentation] Provider config migration failed:", err);
  }
}

/**
 * Forward unhandled route errors to the log store. Fires for exceptions
 * escaping App Router handlers. Dynamic import for the same Edge-safety
 * reason as register().
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string }
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { syslog } = await import("./lib/observability/log-store");
    const message = error instanceof Error ? error.message : String(error);
    syslog("error", "http", `${request.method} ${request.path} → ${message}`);
  } catch {
    // Never let the error hook itself throw.
  }
  console.error(`[http] ${request.method} ${request.path}:`, error);
}
