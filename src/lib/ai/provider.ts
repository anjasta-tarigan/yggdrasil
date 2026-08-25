import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * OpenAI-compatible provider pointing at the self-hosted vLLM server.
 *
 * Configuration comes from environment variables (see .env.example):
 * - LLM_BASE_URL  e.g. http://localhost:20128/v1
 * - LLM_MODEL_ID  e.g. ps/poolside/laguna-s-2.1
 * - LLM_API_KEY   bearer token when the server was started with --api-key
 */

export const defaultModelId =
  process.env.LLM_MODEL_ID ?? "ps/poolside/laguna-s-2.1";

export function getProvider() {
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL) {
    throw new Error("LLM_BASE_URL is not set. Add it to .env.local");
  }
  return createOpenAICompatible({
    name: "vllm",
    baseURL,
    apiKey: process.env.LLM_API_KEY || undefined,
  });
}

export function getDefaultModel() {
  return getProvider().chatModel(defaultModelId);
}

export const llm = {
  chatModel: (modelId: string) => getProvider().chatModel(modelId),
};

export const defaultModel = new Proxy({} as ReturnType<ReturnType<typeof createOpenAICompatible>["chatModel"]>, {
  get(_target, prop, receiver) {
    const target = getDefaultModel();
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === "function") {
      return value.bind(target);
    }
    return value;
  },
});


