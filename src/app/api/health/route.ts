import { bootstrapAutonomousCognitiveSystem } from "@/lib/bootstrap";
import { loadRegistry, resolveApiKey } from "@/lib/ai/provider-config/store";

export const dynamic = "force-dynamic";

/**
 * Lightweight health probe for the configured LLM provider. Reads the
 * provider registry ("server" entry, else the first provider), pings
 * its `/models` endpoint and reports status + latency so the UI can
 * show real-time system health. Always resolves with HTTP 200 and a
 * `status` field so the client can parse a result even when degraded/down.
 */
export async function GET() {
  // Ensure cognitive loop & background runners are bootstrapped
  bootstrapAutonomousCognitiveSystem();

  /**
   * Stamp the server clock as late as possible — right before each
   * Response.json — so the value brackets the probe latency instead of
   * predating it by up to the 5s LLM /models timeout. Clients use this
   * for clock-skew math against their own fetch-start timestamp.
   */
  const stampServerTime = () => ({
    now: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  // Registry-backed target: "server" entry, else the first provider.
  // A missing/corrupt registry is a "down" state, never a thrown 500.
  let baseURL: string | null = null;
  let apiKey: string | undefined;
  let modelId: string | null = null;
  try {
    const doc = await loadRegistry();
    const entry =
      doc.providers.find((p) => p.id === "server") ?? doc.providers[0];
    if (entry) {
      baseURL = entry.baseUrl;
      apiKey = await resolveApiKey(entry);
      // Doc-wide isDefault model, else the first model of that provider.
      const flagged = doc.providers.flatMap((p) =>
        p.models.filter((m) => m.isDefault)
      );
      modelId = flagged[0]?.modelId ?? entry.models[0]?.modelId ?? null;
    }
  } catch {
    // fall through to the "down" response below
  }

  if (!baseURL) {
    return Response.json({
      status: "down",
      modelId,
      serverTime: stampServerTime(),
      error: "No provider configured",
    });
  }

  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!res.ok) {
      return Response.json({
        status: "degraded",
        latencyMs,
        modelId,
        serverTime: stampServerTime(),
        httpStatus: res.status,
      });
    }

    const data = (await res.json()) as { data?: unknown[] };
    const modelCount = Array.isArray(data?.data) ? data.data.length : 0;

    return Response.json({
      status: "ok",
      latencyMs,
      modelId,
      modelCount,
      serverTime: stampServerTime(),
    });
  } catch {
    const latencyMs = Math.round(performance.now() - startedAt);
    return Response.json({
      status: "down",
      latencyMs,
      modelId,
      serverTime: stampServerTime(),
    });
  } finally {
    clearTimeout(timeout);
  }
}
