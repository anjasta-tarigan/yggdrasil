export const dynamic = "force-dynamic";

/**
 * Proxies the model list from the OpenAI-compatible endpoint so the
 * client never needs the API key. Returns a simplified list of ids.
 */
export async function GET() {
  const baseURL = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;

  if (!baseURL) {
    return Response.json({ models: [] });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      return Response.json({ models: [] });
    }

    const data = (await res.json()) as {
      data?: { id?: string }[];
    };

    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");

    return Response.json({ models });
  } catch {
    return Response.json({ models: [] });
  } finally {
    clearTimeout(timeout);
  }
}
