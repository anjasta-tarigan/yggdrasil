import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import { DeepSeekWebAdapter, parseStreamFrames, type AdapterRequestIdentity } from "./deepseek";
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
 * Generation opens the upstream text stream through `DeepSeekWebAdapter`,
 * normalizes every frame with `parseStreamFrames`, and converts the result
 * into AI SDK v4 stream parts. Raw upstream frames never reach the client
 * (Spec §7.2); a malformed frame or a classified upstream failure terminates
 * the stream with a typed error rather than a silent empty stream.
 */

/**
 * Raised when generation is attempted on a web-session model that cannot
 * serve it — currently only the null-session path that bypassed the route's
 * verified-session gate. Typed so callers and tests can assert the failure
 * mode instead of pattern-matching on a message string.
 */
export class WebProviderGenerationUnavailableError extends Error {
  readonly providerId: string;
  readonly modelId: string;

  constructor(providerId: string, modelId: string) {
    super(
      `DeepSeek Web generation is unavailable for "${providerId}::${modelId}" — no verified web-session was supplied.`
    );
    this.name = "WebProviderGenerationUnavailableError";
    this.providerId = providerId;
    this.modelId = modelId;
  }
}

// Structural mirrors of the AI SDK v4 stream-part shapes. `@ai-sdk/provider`
// is not a resolvable dependency (confirmed: it lives only under
// `node_modules/.pnpm`), so the real types cannot be imported here. These
// local types match the emitted members exactly, which keeps this model
// assignable to `LanguageModelV4` without a runtime import — the same
// structural-typing approach `durable-model.ts` documents.
interface V4TextContent {
  type: "text";
  text: string;
}

interface V4GenerateResult {
  content: V4TextContent[];
  finishReason: V4FinishReason;
  usage: V4Usage;
  warnings: never[];
}

interface V4Usage {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
}

interface V4FinishReason {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  raw: string | undefined;
}

type V4StreamPart =
  | { type: "stream-start"; warnings: never[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "finish"; usage: V4Usage; finishReason: V4FinishReason };

const TEXT_PART_ID = "web-text-1";

function zeroUsage(): V4Usage {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function stopFinish(): V4FinishReason {
  return { unified: "stop", raw: "stop" };
}

/**
 * UNVERIFIED — the DeepSeek Web stream frame grammar is not yet confirmed by
 * the protocol spike (Spec §13.1). This extraction is a provisional mapping of
 * the most likely OpenAI-compatible `chat/completions` delta shape
 * (`choices[0].delta.content`), with a narrow fallback to a top-level
 * `content`/`text` field. The spike must confirm or correct this before
 * enablement. Until then, tests pin the *contract* — a recognized delta frame
 * yields a `text-delta` part and a non-delta frame yields none — not any
 * specific provider payload truth.
 *
 * `parseStreamFrames` has already rejected non-JSON frames as a typed
 * `protocol_error`, so any string arriving here is valid JSON; the try/catch
 * is defensive only.
 */
function extractDeltaText(payload: string): string | null {
  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof frame !== "object" || frame === null) return null;
  const obj = frame as Record<string, unknown>;

  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === "object" && first !== null) {
      const delta = (first as Record<string, unknown>).delta;
      if (typeof delta === "object" && delta !== null) {
        const content = (delta as Record<string, unknown>).content;
        if (typeof content === "string" && content.length > 0) return content;
      }
    }
  }

  const content = obj.content;
  if (typeof content === "string" && content.length > 0) return content;
  const text = obj.text;
  if (typeof text === "string" && text.length > 0) return text;

  return null;
}

/**
 * Minimal `LanguageModelV4` implementation for a web-session provider.
 *
 * `supportedUrls` is empty rather than a placeholder: this model resolves no
 * URL natively, so the SDK downloads every remote asset itself — matching
 * `@ai-sdk/openai-compatible`'s own default. Omitting it throws
 * `TypeError: Cannot convert undefined or null to object` as soon as a prompt
 * carries a file part (`isUrlSupported` does an unguarded `Object.entries`).
 */
export class WebProviderLanguageModel {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  /**
   * The verified session the chat route gated on. Generation streams with its
   * `userToken` / user-agent fields; `null` only occurs on a path that
   * bypassed the route gate — generation then fails loudly rather than
   * silently.
   */
  readonly session: WebProviderSession | null;

  private readonly adapter = new DeepSeekWebAdapter();

  constructor(
    providerId: string,
    modelId: string,
    session: WebProviderSession | null
  ) {
    this.provider = providerId;
    this.modelId = modelId;
    this.session = session;
  }

  /** Builds the adapter identity from the gated session, token + user-agent. */
  private identity(): AdapterRequestIdentity {
    const session = this.session;
    if (!session) {
      throw new WebProviderGenerationUnavailableError(this.provider, this.modelId);
    }
    return {
      userToken: session.userToken,
      userAgentMode: session.userAgentMode ?? undefined,
      selectedUserAgent: session.selectedUserAgent,
    };
  }

  /**
   * Opens the upstream stream, converts each frame into an AI SDK v4 part.
   *
   * A classified upstream failure (`AdapterRequestError` from
   * `createTextStream`) propagates from this method so the SDK surfaces it as
   * an SSE error part — never a silent empty stream (Spec §7.2). A malformed
   * frame inside the stream throws a typed `protocol_error` from
   * `parseStreamFrames`, which `controller.error` re-emits as a stream error.
   *
   * The caller's abort signal is threaded into both the request and the frame
   * parser so cancellation cancels the upstream promptly (Spec §12).
   */
  async doStream(options: unknown): Promise<{ stream: ReadableStream<V4StreamPart> }> {
    // Resolve the session-gated identity up front; a missing session fails
    // loudly before any upstream call.
    const identity = this.identity();
    const optionsRecord = (options ?? {}) as {
      prompt?: unknown;
      abortSignal?: AbortSignal;
    };
    const messages = Array.isArray(optionsRecord.prompt)
      ? optionsRecord.prompt
      : [];
    const signal = optionsRecord.abortSignal;

    const upstream = await this.adapter.createTextStream(
      identity,
      { prompt: "", messages },
      signal
    );

    const stream = new ReadableStream<V4StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        controller.enqueue({ type: "text-start", id: TEXT_PART_ID });
        try {
          for await (const payload of parseStreamFrames(upstream, {}, signal)) {
            const delta = extractDeltaText(payload);
            if (delta !== null) {
              controller.enqueue({ type: "text-delta", id: TEXT_PART_ID, delta });
            }
          }
          controller.enqueue({ type: "text-end", id: TEXT_PART_ID });
          controller.enqueue({
            type: "finish",
            usage: zeroUsage(),
            finishReason: stopFinish(),
          });
          controller.close();
        } catch (error) {
          // Typed classified failure (401/429/…) or protocol_error on a
          // malformed frame: surface it as a stream error, not an empty stream.
          controller.error(error);
        }
      },
    });

    return { stream };
  }

  /**
   * Non-streaming variant: consumes the streaming path and aggregates the
   * emitted parts into a single text content block. Reuses `doStream` so the
   * two code paths cannot drift.
   */
  async doGenerate(options: unknown): Promise<V4GenerateResult> {
    const result = (await this.doStream(options)) as {
      stream: ReadableStream<V4StreamPart>;
    };
    const reader = result.stream.getReader();

    let text = "";
    let finishReason: V4FinishReason = stopFinish();
    let usage: V4Usage = zeroUsage();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.type === "text-delta") {
          text += value.delta;
        } else if (value?.type === "finish") {
          finishReason = value.finishReason;
          usage = value.usage;
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      content: [{ type: "text", text }],
      finishReason,
      usage,
      warnings: [],
    };
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
