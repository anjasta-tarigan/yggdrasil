import { generateId } from "ai";

/**
 * Params for {@link buildRuntimeContext}.
 */
export interface RuntimeContextParams {
  chatId: string;
  modelId: string;
  /**
   * Request-scoped correlation id. When omitted, a unique id is generated
   * with the AI SDK's `generateId()` so every generation can be traced back
   * to a single HTTP request.
   */
  requestId?: string;
  /** Feature flags toggled for this generation (defaults to `{}`). */
  featureFlags?: Record<string, boolean>;
}

/**
 * Build the request-scoped `runtimeContext` object that AI SDK v7 flows
 * through `streamText()` and `ToolLoopAgent` — across `prepareStep`,
 * lifecycle callbacks, and step results.
 *
 * The object is intentionally serializable (no handles, functions, or
 * circular refs) so it can be logged, replayed, and forwarded to subagents.
 *
 * NOTE: the AI SDK's default `generateId()` produces a compact unique token
 * (not a 64-char UUID); uniqueness — not literal length — is the contract
 * relied on by callers for correlation/logging.
 */
export function buildRuntimeContext(params: RuntimeContextParams): Record<string, unknown> {
  const { chatId, modelId, requestId, featureFlags } = params;
  return {
    requestId: requestId ?? generateId(),
    chatId,
    modelId,
    featureFlags: featureFlags ?? {},
    startedAt: new Date().toISOString(),
  };
}
