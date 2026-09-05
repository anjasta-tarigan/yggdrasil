import { NextResponse } from "next/server";
import {
  detectEmbeddingDimensions,
  type EmbeddingProviderKind,
} from "@/lib/memory/embeddings";

/**
 * Probe an embedding endpoint and report the model's native vector
 * dimension. Body: { providerId } (registry provider — key resolved
 * server-side) or { provider, baseUrl?, apiKey?, model? } (standalone).
 *
 * Used by Settings → Embedding before saving, so the stored
 * configuration always carries a verified dimension.
 */

type DetectPayload = {
  providerId?: string;
  provider?: EmbeddingProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function sanitizePayload(body: unknown): DetectPayload | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const p = body as Record<string, unknown>;

  if (p.providerId !== undefined && typeof p.providerId !== "string") {
    return null;
  }
  if (
    p.provider !== undefined &&
    p.provider !== "server" &&
    p.provider !== "openai-compatible" &&
    p.provider !== "ollama"
  ) {
    return null;
  }
  if (!p.providerId && !p.provider) return null;
  if (
    p.baseUrl !== undefined &&
    (typeof p.baseUrl !== "string" ||
      !/^https?:\/\//.test(p.baseUrl) ||
      p.baseUrl.length > 2048)
  ) {
    return null;
  }
  if (p.apiKey !== undefined && typeof p.apiKey !== "string") return null;
  if (
    p.model !== undefined &&
    (typeof p.model !== "string" || p.model.length > 200)
  ) {
    return null;
  }

  return {
    ...(typeof p.providerId === "string" ? { providerId: p.providerId } : {}),
    ...(p.provider !== undefined
      ? { provider: p.provider as EmbeddingProviderKind }
      : {}),
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
    apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined,
    model: typeof p.model === "string" ? p.model : undefined,
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = sanitizePayload(body);
  if (!payload) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  try {
    const result = await detectEmbeddingDimensions(payload);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Dimension probe failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
