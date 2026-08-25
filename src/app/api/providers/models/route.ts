import { NextResponse } from "next/server";

/**
 * Model-list proxy for user-added providers.
 *
 * Fetching third-party model lists from the browser runs into CORS and
 * mixed-content issues, so the client POSTs the provider's connection
 * details here and this route fetches the list server-side:
 *
 * - openai-compatible → GET {baseUrl}/models   (OpenAI-style listing)
 * - ollama            → GET {baseUrl}/api/tags (native Ollama listing)
 *
 * Inputs are shape-guarded exactly like the chat route's provider
 * overrides. API keys are only ever forwarded to the URL the user
 * configured.
 */

type RequestBody = {
  apiKey?: string;
  baseUrl?: string;
  kind?: string;
};

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const baseUrl =
    typeof body.baseUrl === "string" &&
    body.baseUrl.length <= 2048 &&
    /^https?:\/\//.test(body.baseUrl)
      ? body.baseUrl.trim().replace(/\/$/, "")
      : null;
  if (!baseUrl) {
    return NextResponse.json({ error: "Invalid baseUrl" }, { status: 400 });
  }

  const apiKey =
    typeof body.apiKey === "string" && body.apiKey.length <= 2048
      ? body.apiKey.trim() || undefined
      : undefined;

  try {
    if (body.kind === "ollama") {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return NextResponse.json(
          { error: `Ollama responded with ${res.status}` },
          { status: 502 }
        );
      }
      const data = (await res.json()) as {
        models?: Array<{ name?: string }>;
      };
      const models = (data.models ?? [])
        .map((m) => m.name)
        .filter((name): name is string => typeof name === "string" && !!name)
        .map((id) => ({ id }));
      return NextResponse.json({ models });
    }

    // OpenAI-compatible listing.
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Endpoint responded with ${res.status}` },
        { status: 502 }
      );
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && !!id)
      .map((id) => ({ id }));
    return NextResponse.json({ models });
  } catch {
    return NextResponse.json(
      { error: "Could not reach the provider endpoint" },
      { status: 502 }
    );
  }
}
