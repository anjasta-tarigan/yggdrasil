import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import { AdapterRequestError, DeepSeekWebAdapter, parseStreamFrames, type AdapterRequestIdentity } from "./deepseek";
import { ERROR_MAPPING } from "./adapter";
import { recordProtocolFailure } from "./circuit-breaker";
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
 * (Spec §7.2); a malformed or unrecognized frame, or a classified upstream
 * failure, terminates the stream with a typed error rather than a silent
 * empty stream.
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
  warnings: V4Warning[];
}

/** Mirrors the `unsupported` arm of `SharedV4Warning`. */
interface V4Warning {
  type: "unsupported";
  feature: string;
  details?: string;
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
  | { type: "stream-start"; warnings: V4Warning[] }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "finish"; usage: V4Usage; finishReason: V4FinishReason };

const TEXT_PART_ID = "web-text-1";

/**
 * The web-session protocol is text-only (Spec §7.2): tools, structured
 * output, reasoning, and every sampling parameter are not implemented. Those
 * options are stripped and reported as `unsupported` warnings on
 * `stream-start` — the AI SDK's own warning channel — rather than silently
 * dropped, so an operator can see exactly what the provider ignored. Nothing
 * here advertises support.
 */
const UNSUPPORTED_OPTION_FEATURES: ReadonlyArray<{
  key: string;
  feature: string;
  details: string;
}> = [
  { key: "tools", feature: "tools", details: "Web Provider is text-only; tool calls are not supported." },
  { key: "toolChoice", feature: "toolChoice", details: "Web Provider is text-only; tool choice is not supported." },
  { key: "maxOutputTokens", feature: "maxOutputTokens", details: "Web Provider does not honor an output-token cap." },
  { key: "responseFormat", feature: "responseFormat", details: "Web Provider does not support structured output." },
  { key: "reasoning", feature: "reasoning", details: "Web Provider does not support reasoning-effort control." },
  { key: "temperature", feature: "temperature", details: "Web Provider does not honor temperature." },
  { key: "topP", feature: "topP", details: "Web Provider does not honor top-p." },
  { key: "topK", feature: "topK", details: "Web Provider does not honor top-k." },
  { key: "seed", feature: "seed", details: "Web Provider does not honor a seed." },
  { key: "stopSequences", feature: "stopSequences", details: "Web Provider does not honor stop sequences." },
  { key: "presencePenalty", feature: "presencePenalty", details: "Web Provider does not honor presence penalty." },
  { key: "frequencyPenalty", feature: "frequencyPenalty", details: "Web Provider does not honor frequency penalty." },
  { key: "providerOptions", feature: "providerOptions", details: "Web Provider does not accept provider-specific options." },
  { key: "headers", feature: "headers", details: "Web Provider does not accept caller-supplied request headers." },
  { key: "includeRawChunks", feature: "includeRawChunks", details: "Web Provider does not emit raw provider chunks." },
];

/**
 * Reports the call options this provider will ignore. `usage` and
 * `finishReason` are not protocol-verified for DeepSeek Web (Spec §13.1), so
 * completion metadata is reported as honest "unknown"/"other" rather than a
 * fabricated zero count or a `stop` reason.
 */
function unknownUsage(): V4Usage {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
}

function unknownFinish(): V4FinishReason {
  return { unified: "other", raw: "web-provider:unverified" };
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

function collectUnsupportedWarnings(options: Record<string, unknown>): V4Warning[] {
  const warnings: V4Warning[] = [];
  for (const { key, feature, details } of UNSUPPORTED_OPTION_FEATURES) {
    const value = options[key];
    if (value === undefined) continue;
    // An empty toolset or empty providerOptions is the route's default shape,
    // not a dropped feature.
    if (key === "tools" && Array.isArray(value) && value.length === 0) continue;
    if (key === "providerOptions" && isEmptyObject(value)) continue;
    warnings.push({ type: "unsupported", feature, details });
  }
  return warnings;
}

/** A closed, sanitized typed error carrying the adapter's failure shape. */
function failureError(
  code: "protocol_error" | "unsupported_protocol",
  detail?: string
): AdapterRequestError {
  const mapping = ERROR_MAPPING[code];
  return new AdapterRequestError({
    ok: false,
    code,
    httpStatus: mapping.status,
    message: detail ? `${mapping.message} ${detail}` : mapping.message,
  });
}

/**
 * UNVERIFIED — the DeepSeek Web stream frame grammar is not yet confirmed by
 * the protocol spike (Spec §13.1). This classification is a provisional
 * mapping of the most likely OpenAI-compatible `chat/completions` delta shape
 * (`choices[0].delta.content`), with a narrow fallback to a top-level
 * `content`/`text` field. The spike must confirm or correct this before
 * enablement. Until then, tests pin the *contract*: a recognized delta frame
 * yields a `text-delta`, an explicitly allowed metadata frame is dropped, and
 * any other frame yields a typed `protocol_error`.
 *
 * `parseStreamFrames` has already rejected non-JSON frames as a typed
 * `protocol_error`, so any string arriving here is valid JSON.
 */
type FrameOutcome = { kind: "delta"; text: string } | { kind: "metadata" };

function classifyFrame(payload: string): FrameOutcome {
  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    throw failureError("protocol_error");
  }
  if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
    throw failureError("protocol_error");
  }
  const obj = frame as Record<string, unknown>;

  const choices = obj.choices;
  if (Array.isArray(choices)) {
    // No candidates: a usage/metadata frame, not content.
    if (choices.length === 0) return { kind: "metadata" };
    const first = choices[0];
    if (typeof first !== "object" || first === null) throw failureError("protocol_error");
    const delta = (first as Record<string, unknown>).delta;
    if (delta === undefined) {
      // `choices[0]` without a delta is a non-streaming message shape — unverified.
      throw failureError("protocol_error");
    }
    if (typeof delta !== "object" || delta === null) throw failureError("protocol_error");
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === "string" && content.length > 0) {
      return { kind: "delta", text: content };
    }
    // An empty/role-only delta (OpenAI's first chunk carries the role) is
    // metadata, explicitly allowed and dropped.
    return { kind: "metadata" };
  }

  const content = obj.content;
  if (typeof content === "string" && content.length > 0) return { kind: "delta", text: content };
  const text = obj.text;
  if (typeof text === "string" && text.length > 0) return { kind: "delta", text: text };

  // Explicitly allowed metadata: a usage-only frame or a frame that declares
  // itself a heartbeat/metadata frame (narrow, unverified allowlist).
  if (typeof obj.usage === "object" && obj.usage !== null) return { kind: "metadata" };
  if (obj.type === "heartbeat" || obj.type === "metadata") return { kind: "metadata" };

  // Any other recognized-but-unhandled JSON shape is unverified output —
  // surface it as a protocol error rather than silently dropping it into a
  // partial successful response (Spec §7.2).
  throw failureError("protocol_error");
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
   * Opens the upstream stream and converts each frame into an AI SDK v4 part.
   *
   * A classified upstream failure (`AdapterRequestError` from
   * `createTextStream`) propagates from this method so the SDK surfaces it as
   * an SSE error part — never a silent empty stream (Spec §7.2). A malformed,
   * unrecognized, or non-text frame inside the stream throws a typed
   * `protocol_error`, which `controller.error` re-emits as a stream error.
   *
   * The returned stream owns a combined `AbortController`: a downstream cancel
   * aborts it, which aborts both the upstream request and the frame parser, so
   * no upstream bytes keep flowing after the consumer stops (Spec §12).
   */
  async doStream(options: unknown): Promise<{ stream: ReadableStream<V4StreamPart> }> {
    // Resolve the session-gated identity up front; a missing session fails
    // loudly before any upstream call.
    const identity = this.identity();
    const optionsRecord = (options ?? {}) as Record<string, unknown> & {
      prompt?: unknown;
      abortSignal?: AbortSignal;
    };
    const warnings = collectUnsupportedWarnings(optionsRecord);
    // A non-text prompt part cannot be served faithfully — dropping it would
    // silently starve the answer of context the user attached (Spec §7.2).
    this.assertTextOnlyPrompt(optionsRecord.prompt);
    const messages = this.extractTextMessages(optionsRecord.prompt);
    const callerSignal = optionsRecord.abortSignal;

    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;

    const upstream = await this.adapter.createTextStream(
      identity,
      { prompt: "", messages },
      signal
    );

    let cancelled = false;
    // Captured here: inside the stream source, `this` is the underlying source
    // object, not the model.
    const providerId = this.provider;
    const stream = new ReadableStream<V4StreamPart>({
      async start(streamController) {
        const emit = (part: V4StreamPart) => {
          if (!cancelled) streamController.enqueue(part);
        };
        emit({ type: "stream-start", warnings });
        emit({ type: "text-start", id: TEXT_PART_ID });
        try {
          for await (const payload of parseStreamFrames(upstream, {}, signal)) {
            const frame = classifyFrame(payload);
            if (frame.kind === "delta") {
              emit({ type: "text-delta", id: TEXT_PART_ID, delta: frame.text });
            }
          }
          if (cancelled) return;
          emit({ type: "text-end", id: TEXT_PART_ID });
          emit({ type: "finish", usage: unknownUsage(), finishReason: unknownFinish() });
          streamController.close();
        } catch (error) {
          // Typed classified failure (401/429/…), or protocol_error on a
          // malformed/unknown frame: surface it as a stream error, not an
          // empty stream. A downstream cancel already tore the stream down.
          if (!cancelled) {
            // Spec §11.3: a protocol parse failure at the stream boundary feeds
            // the circuit breaker before the error is re-emitted.
            if (error instanceof AdapterRequestError) {
              await recordProtocolFailure(providerId, error.failure.code);
            }
            streamController.error(error);
          }
        }
      },
      cancel() {
        // Downstream cancellation must abort the upstream request and stop the
        // frame parser (which clears its idle timer and abort listener).
        cancelled = true;
        controller.abort();
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
    let finishReason: V4FinishReason = unknownFinish();
    let usage: V4Usage = unknownUsage();
    let warnings: V4Warning[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.type === "stream-start") {
          warnings = value.warnings;
        } else if (value?.type === "text-delta") {
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
      warnings,
    };
  }

  /**
   * Spec §7.2: the web-session protocol supports text only. A prompt carrying
   * a file/attachment, reasoning, or tool part cannot be served faithfully —
   * dropping it would silently answer a question about content the model never
   * saw. Reject up front with a typed `unsupported_protocol` error.
   */
  private assertTextOnlyPrompt(prompt: unknown): void {
    if (!Array.isArray(prompt)) return;
    for (const message of prompt) {
      if (typeof message !== "object" || message === null) continue;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type !== "text"
        ) {
          throw failureError(
            "unsupported_protocol",
            "Web Provider supports text messages only; attachments, reasoning, and tool parts are not supported."
          );
        }
      }
    }
  }

  /**
   * Extracts the text content of each prompt message. Non-text parts are
   * rejected by {@link assertTextOnlyPrompt}, so only text remains.
   */
  private extractTextMessages(prompt: unknown): unknown[] {
    if (!Array.isArray(prompt)) return [];
    return prompt.map((message) => {
      if (typeof message !== "object" || message === null) return message;
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return message;
      if (Array.isArray(content)) {
        return {
          ...(message as object),
          content: content
            .map((part) =>
              typeof part === "object" && part !== null
                ? (part as { text?: unknown }).text
                : undefined
            )
            .filter((text): text is string => typeof text === "string")
            .join(""),
        };
      }
      return message;
    });
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
