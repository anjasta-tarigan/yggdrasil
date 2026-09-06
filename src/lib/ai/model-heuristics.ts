/**
 * Pure, client-safe model capability inference and heuristics.
 * Zero Node.js dependencies — safe for both React client components and server routes.
 */

export interface InferredModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
  supportsToolCalls: boolean;
  inputModalities: ("text" | "image" | "audio" | "video" | "pdf")[];
  outputModalities: ("text" | "image" | "audio" | "video" | "pdf")[];
}

/**
 * Built-in capability inference for recognized model families.
 * Serves as an authoritative fallback when upstream metadata (/models) is
 * missing context limits (like standard OpenAI or DeepSeek APIs) and
 * models.dev catalog is either offline or does not list the model yet.
 */
export function inferKnownModelCapabilities(
  modelId: string
): InferredModelCapabilities | null {
  if (!modelId) return null;
  const id = modelId.toLowerCase();

  // DeepSeek V4 (1M context, 384k max output)
  if (id.includes("deepseek") && (id.includes("v4") || id.includes("-v4"))) {
    return {
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      supportsReasoning: true,
      supportsToolCalls: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
    };
  }

  // DeepSeek V3 / R1 / chat / coder (128k context, 32k / 64k output)
  if (id.includes("deepseek")) {
    const isReasoning =
      id.includes("r1") || id.includes("reasoner") || id.includes("thinking");
    return {
      contextWindow: 128_000,
      maxOutputTokens: isReasoning ? 32_000 : 8_192,
      supportsReasoning: isReasoning,
      supportsToolCalls: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
    };
  }

  // Poolside / Laguna (1M context: 1,048,576, 131k output)
  if (id.includes("laguna") || id.includes("poolside")) {
    return {
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      supportsReasoning: true,
      supportsToolCalls: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
    };
  }

  // Minimax M3 (512k context, 80k-131k output)
  if (id.includes("minimax") && (id.includes("m3") || id.includes("text-01"))) {
    return {
      contextWindow: 512_000,
      maxOutputTokens: 131_072,
      supportsReasoning: true,
      supportsToolCalls: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
    };
  }
  if (id.includes("minimax")) {
    return {
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      supportsReasoning: true,
      supportsToolCalls: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
    };
  }

  // Claude 3.5 / 3.7 / Opus / Sonnet (200k context)
  if (id.includes("claude")) {
    return {
      contextWindow: 200_000,
      maxOutputTokens:
        id.includes("3-5") ||
        id.includes("3.5") ||
        id.includes("3-7") ||
        id.includes("3.7")
          ? 64_000
          : 8_192,
      supportsReasoning: id.includes("3-7") || id.includes("thinking"),
      supportsToolCalls: true,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
    };
  }

  // OpenAI reasoning models (o1, o3, o4) (200k context)
  if (
    /\b(o1|o3|o4)\b/.test(id) ||
    /^(o1|o3|o4)(-|\/)/.test(id) ||
    id.includes("/o1") ||
    id.includes("/o3")
  ) {
    return {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      supportsReasoning: true,
      supportsToolCalls: true,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    };
  }

  // OpenAI GPT-4o / GPT-4o-mini (128k context)
  if (id.includes("gpt-4o")) {
    return {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsReasoning: false,
      supportsToolCalls: true,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
    };
  }

  // Google Gemini (1M / 2M context)
  if (id.includes("gemini")) {
    const is2M = id.includes("1.5-pro") || id.includes("2.0-pro");
    return {
      contextWindow: is2M ? 2_000_000 : 1_000_000,
      maxOutputTokens: 64_000,
      supportsReasoning:
        id.includes("thinking") || id.includes("2.0-flash-thinking"),
      supportsToolCalls: true,
      inputModalities: ["text", "image", "audio", "video", "pdf"],
      outputModalities: ["text"],
    };
  }

  // Qwen 2.5 / Qwen 3 (128k context)
  if (id.includes("qwen")) {
    return {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsReasoning: id.includes("qwq") || id.includes("reasoning"),
      supportsToolCalls: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
    };
  }

  // Meta Llama 3.1 / 3.2 / 3.3 (128k context)
  if (
    id.includes("llama-3.1") ||
    id.includes("llama-3.2") ||
    id.includes("llama-3.3") ||
    id.includes("llama-3-")
  ) {
    return {
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsReasoning: false,
      supportsToolCalls: true,
      inputModalities: id.includes("vision") ? ["text", "image"] : ["text"],
      outputModalities: ["text"],
    };
  }

  return null;
}
