import { NextResponse } from "next/server";
import { syslog } from "@/lib/observability/log-store";
import {
  probeRerankerEndpoint,
  type RerankerProbe,
} from "@/lib/memory/reranker";

/**
 * Probe a remote OpenAI-compatible `/v1/rerank` endpoint and report
 * connectivity, authentication, and model availability.
 * Body: { provider: "openai-compatible", baseUrl, model, apiKeyEnv?, apiKey? }
 *
 * Used by Settings → Reranker before saving, so the stored configuration
 * always points at a verified endpoint.
 */

type ProbePayload = {
  provider: "openai-compatible";
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
};

function sanitizePayload(body: unknown): ProbePayload | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const p = body as Record<string, unknown>;

  if (
    p.provider !== "openai-compatible" &&
    p.provider !== undefined &&
    p.provider !== null
  ) {
    return null;
  }
  if (!p.provider && !p.baseUrl) return null;

  if (
    p.baseUrl !== undefined &&
    (typeof p.baseUrl !== "string" ||
      !/^https?:\/\//.test(p.baseUrl) ||
      p.baseUrl.length > 2048)
  ) {
    return null;
  }
  if (p.apiKey !== undefined && typeof p.apiKey !== "string") return null;
  if (p.apiKeyEnv !== undefined && typeof p.apiKeyEnv !== "string") {
    return null;
  }
  if (
    p.model !== undefined &&
    (typeof p.model !== "string" || p.model.length > 200)
  ) {
    return null;
  }

  return {
    provider: "openai-compatible",
    baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined,
    apiKey: typeof p.apiKey === "string" ? p.apiKey : undefined,
    apiKeyEnv: typeof p.apiKeyEnv === "string" ? p.apiKeyEnv : undefined,
    model: typeof p.model === "string" ? p.model : undefined,
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    syslog(
      "debug",
      "route",
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = sanitizePayload(body);
  if (!payload) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (!payload.baseUrl || !payload.model) {
    return NextResponse.json(
      { error: "baseUrl and model are required for remote probe" },
      { status: 400 },
    );
  }

  try {
    const probe: RerankerProbe = {
      baseUrl: payload.baseUrl,
      model: payload.model,
      apiKeyEnv: payload.apiKeyEnv,
      apiKey: payload.apiKey,
    };
    const result = await probeRerankerEndpoint(probe);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Reranker probe failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
