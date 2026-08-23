export const dynamic = "force-dynamic";

/**
 * Lightweight health probe for the self-hosted LLM endpoint.
 * Pings `{LLM_BASE_URL}/models` and reports status + latency so the UI
 * can show real-time system health. Always resolves with HTTP 200 and a
 * `status` field so the client can parse a result even when degraded/down.
 */
export async function GET() {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const modelId = process.env.LLM_MODEL_ID;

  if (!baseURL) {
    return Response.json({
      status: "down",
      modelId,
      error: "LLM_BASE_URL is not set",
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
        httpStatus: res.status,
      });
    }

    const data = (await res.json()) as { data?: unknown[] };
    const modelCount = Array.isArray(data?.data) ? data.data.length : 0;

    return Response.json({ status: "ok", latencyMs, modelId, modelCount });
  } catch {
    const latencyMs = Math.round(performance.now() - startedAt);
    return Response.json({ status: "down", latencyMs, modelId });
  } finally {
    clearTimeout(timeout);
  }
}
