import { NextResponse } from "next/server";
import { browseProviderModels } from "@/lib/ai/models";

/**
 * Model-list proxy for user-added providers.
 *
 * Fetching third-party model lists from the browser runs into CORS and
 * mixed-content issues, so the client POSTs the provider's connection
 * details here and this route lists the models server-side through
 * `browseProviderModels` — the single shared fetch/parse path (no
 * duplicated listing logic).
 *
 * Inputs are shape-guarded exactly like the chat route's provider
 * overrides. API keys are only ever forwarded to the URL the user
 * configured. The response keeps its historical shape: one bare
 * `{ id }` per model — the context-window metadata the helper also
 * returns is stripped, since consumers (settings-view, the model
 * selector's provider groups) only read `id`.
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

  // Unknown kinds fall through to the OpenAI-compatible listing, matching
  // the previous inline implementation's behavior.
  const kind = body.kind === "ollama" ? "ollama" : "openai-compatible";

  try {
    const models = await browseProviderModels(baseUrl, apiKey, kind);
    return NextResponse.json({ models: models.map((m) => ({ id: m.id })) });
  } catch {
    // browseProviderModels swallows fetch/parse failures; this only guards
    // against the unexpected throw so the route keeps its 502 contract.
    return NextResponse.json(
      { error: "Could not reach the provider endpoint" },
      { status: 502 },
    );
  }
}
