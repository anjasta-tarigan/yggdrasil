import { NextResponse } from "next/server";
import { env } from "@/env";

/**
 * Ollama auto-detection.
 *
 * Probes candidate endpoints server-side (no browser CORS issues, and
 * the OLLAMA_HOST environment variable is honored when set) and returns
 * the first live one together with its installed models from /api/tags.
 * Ollama needs no API key.
 */

type OllamaTag = {
  name: string;
  size?: number;
  details?: { family?: string; parameter_size?: string };
};

function candidateEndpoints(): string[] {
  const candidates: string[] = [];
  const envHost = env.OLLAMA_HOST;
  if (envHost) {
    candidates.push(
      /^https?:\/\//.test(envHost) ? envHost : `http://${envHost}`
    );
  }
  candidates.push("http://localhost:11434", "http://127.0.0.1:11434");
  // De-duplicate while preserving probe order.
  return [...new Set(candidates.map((c) => c.replace(/\/$/, "")))];
}

export async function GET() {
  for (const baseUrl of candidateEndpoints()) {
    try {
      const res = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { models?: OllamaTag[] };
      const models = (data.models ?? []).map((m) => ({
        name: m.name,
        parameterSize: m.details?.parameter_size ?? null,
        size: typeof m.size === "number" ? m.size : null,
      }));
      return NextResponse.json({ baseUrl, detected: true, models });
    } catch {
      // Endpoint unreachable — try the next candidate.
    }
  }
  return NextResponse.json({ baseUrl: null, detected: false, models: [] });
}
