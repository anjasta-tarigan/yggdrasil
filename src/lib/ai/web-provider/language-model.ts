import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import type { WebProviderSession } from "./types";

/**
 * Web-session provider → AI SDK language model.
 *
 * A `kind: "web-session"` provider (DeepSeek Web) authenticates with a
 * browser-captured token, not an API key, and speaks the site's private SSE
 * protocol instead of OpenAI chat completions. `chatModelForEntry` therefore
 * never routes this kind through `createOpenAICompatible`; it builds this
 * model instead, so the chat route's existing `streamText` wiring is reused
 * unchanged.
 *
 * Task 9c replaces the generation bodies with the real adapter call
 * (`DeepSeekWebAdapter.createTextStream` + `parseStreamFrames`) converted
 * into AI SDK stream parts. Until then the model is deliberately
 * non-functional: it fails loudly with a typed error rather than emitting an
 * empty stream, which would look to the user like a model that answered
 * nothing (the silent-success defect this gate exists to prevent).
 */

/**
 * Raised when generation is attempted on a web-session model that cannot
 * serve it. Typed so callers and tests can assert the failure mode instead
 * of pattern-matching on a message string.
 */
export class WebProviderGenerationUnavailableError extends Error {
  readonly providerId: string;
  readonly modelId: string;

  constructor(providerId: string, modelId: string) {
    super(
      `DeepSeek Web generation is unavailable for "${providerId}::${modelId}" — the web-session streaming adapter is not enabled in this build.`
    );
    this.name = "WebProviderGenerationUnavailableError";
    this.providerId = providerId;
    this.modelId = modelId;
  }
}

/**
 * Minimal `LanguageModelV4` implementation for a web-session provider.
 *
 * `supportedUrls` is empty rather than a placeholder: this model resolves no
 * URL natively, so the SDK downloads every remote asset itself — matching
 * `@ai-sdk/openai-compatible`'s own default. Omitting it would throw
 * `TypeError: Cannot convert undefined or null to object` as soon as a prompt
 * carries a file part (`isUrlSupported` does an unguarded `Object.entries`).
 */
export class WebProviderLanguageModel {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  /**
   * The verified session the chat route gated on. Task 9c's adapter streams
   * with its `userToken` / user-agent fields; the placeholder records it so
   * the seam is already in place. `null` only occurs on a path that bypassed
   * the route gate — generation then fails loudly rather than silently.
   */
  readonly session: WebProviderSession | null;

  constructor(
    providerId: string,
    modelId: string,
    session: WebProviderSession | null
  ) {
    this.provider = providerId;
    this.modelId = modelId;
    this.session = session;
  }

  /** @throws {WebProviderGenerationUnavailableError} always, until Task 9c. */
  async doStream(): Promise<never> {
    throw new WebProviderGenerationUnavailableError(this.provider, this.modelId);
  }

  /** @throws {WebProviderGenerationUnavailableError} always, until Task 9c. */
  async doGenerate(): Promise<never> {
    throw new WebProviderGenerationUnavailableError(this.provider, this.modelId);
  }
}

/**
 * Builds the language model for a `kind: "web-session"` registry entry.
 *
 * `session` is the already-verified row the chat route gated on; a `null`
 * session is accepted rather than thrown here because the gate lives in the
 * route — a construction-time throw would surface as an opaque 500 instead of
 * the route's actionable 401.
 */
export function createWebProviderModel(
  entry: ProviderEntry,
  modelId: string,
  session: WebProviderSession | null
): WebProviderLanguageModel {
  return new WebProviderLanguageModel(entry.id, modelId, session);
}
