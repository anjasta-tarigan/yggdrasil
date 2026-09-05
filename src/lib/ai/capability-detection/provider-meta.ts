import { Capabilities, ProviderKind, Modality } from "@/lib/ai/provider-config/schema";

/** First finite positive number among the candidates. */
function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return null;
}

type UpstreamModel = {
  id?: string;
  name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  capabilities?: {
    contextWindow?: number;
    maxOutput?: number;
    tools?: boolean;
    reasoning?: boolean;
    inputModalities?: Modality[];
    outputModalities?: Modality[];
  };
};

/**
 * Fetch provider metadata from upstream endpoints:
 * 1. GET {baseUrl}/models (with 5s timeout, Bearer auth if apiKey is present).
 * 2. If kind === "ollama" and modelId provided: POST {origin}/api/show with { model: modelId }.
 * Returns Partial<Capabilities> containing only found fields.
 */
export async function fetchProviderMetadata(opts: {
  baseUrl: string;
  apiKey?: string;
  kind: ProviderKind;
  modelId?: string;
}): Promise<Partial<Capabilities>> {
  const result: Partial<Capabilities> = {};
  if (!opts.baseUrl) return result;

  const normalizedBase = opts.baseUrl.replace(/\/$/, "");

  // 1. GET {baseUrl}/models
  try {
    const res = await fetch(`${normalizedBase}/models`, {
      headers: opts.apiKey
        ? { Authorization: `Bearer ${opts.apiKey}` }
        : undefined,
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        data?: UpstreamModel[];
        models?: UpstreamModel[];
      };
      const list = data.data ?? data.models ?? [];
      const model = opts.modelId
        ? list.find(
            (m) =>
              m.id === opts.modelId ||
              m.name === opts.modelId ||
              m.id?.toLowerCase() === opts.modelId?.toLowerCase() ||
              m.name?.toLowerCase() === opts.modelId?.toLowerCase()
          )
        : list[0];

      if (model) {
        const ctx = firstPositive(
          model.context_length,
          model.capabilities?.contextWindow
        );
        if (ctx !== null) {
          result.contextWindow = ctx;
        }

        const out = firstPositive(
          model.max_completion_tokens,
          model.max_output_tokens,
          model.capabilities?.maxOutput
        );
        if (out !== null) {
          result.maxOutputTokens = out;
        }

        if (typeof model.capabilities?.tools === "boolean") {
          result.supportsToolCalls = model.capabilities.tools;
        }
        if (typeof model.capabilities?.reasoning === "boolean") {
          result.supportsReasoning = model.capabilities.reasoning;
        }
        if (Array.isArray(model.capabilities?.inputModalities)) {
          result.inputModalities = model.capabilities.inputModalities;
        }
        if (Array.isArray(model.capabilities?.outputModalities)) {
          result.outputModalities = model.capabilities.outputModalities;
        }
      }
    }
  } catch {
    // Failed to query /models, continue to Ollama fallback if applicable
  }

  // 2. Ollama /api/show if kind === "ollama" and modelId provided
  if (opts.kind === "ollama" && opts.modelId) {
    try {
      const origin = new URL(opts.baseUrl).origin;
      const showRes = await fetch(`${origin}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: opts.modelId }),
        signal: AbortSignal.timeout(5000),
      });

      if (showRes.ok) {
        const showData = (await showRes.json()) as {
          capabilities?: string[];
          model_info?: Record<string, any>;
        };

        if (Array.isArray(showData.capabilities)) {
          const caps = showData.capabilities.map((c) => c.toLowerCase());
          if (caps.includes("tools")) {
            result.supportsToolCalls = true;
          }
          if (caps.includes("vision")) {
            const inputs = new Set(result.inputModalities ?? ["text"]);
            inputs.add("image");
            result.inputModalities = Array.from(inputs) as Modality[];
          }
        }
      }
    } catch {
      // Ollama show endpoint failure is non-fatal
    }
  }

  return result;
}
