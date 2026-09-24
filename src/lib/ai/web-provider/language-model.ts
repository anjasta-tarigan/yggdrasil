import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import {
  AdapterRequestError,
  DeepSeekWebAdapter,
  parseStreamFrames,
  type AdapterRequestIdentity,
} from "./deepseek";
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
 * into AI SDK v4 stream parts. The upstream protocol is a JSON-patch stream
 * (Spec A5): `v.response` carries the initial fragment list, `p`/`o`/`v` frames
 * are path-patch operations on the active fragment, and `FINISHED` closes the
 * turn. Raw upstream frames never reach the client (Spec §7.2); a malformed,
 * unrecognized, or non-text frame, or a classified upstream failure, terminates
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

interface V4ReasoningContent {
  type: "reasoning";
  text: string;
}

type V4ContentBlock = V4TextContent | V4ReasoningContent;

interface V4GenerateResult {
  content: V4ContentBlock[];
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
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "finish"; usage: V4Usage; finishReason: V4FinishReason };

const TEXT_PART_ID = "web-text-1";
const REASONING_PART_ID = "web-reasoning-1";
/** Grace period after FINISHED before closing, to drain trailing metadata frames (Spec A5). */
const FINISHED_DRAIN_MS = 750;

/**
 * The web-session protocol is text-only for callers (Spec §7.2): tools,
 * structured output, and sampling parameters are not implemented. Those options
 * are stripped and reported as `unsupported` warnings on `stream-start` — the AI
 * SDK's own warning channel — rather than silently dropped, so an operator can
 * see exactly what the provider ignored. Nothing here advertises support.
 *
 * `reasoning` is listed because the caller's *reasoning-effort* control is not
 * honored — thinking is driven by model selection (`deepseek-reasoner`), not by
 * an option the chat route forwards.
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
  { key: "reasoning", feature: "reasoning", details: "Web Provider drives thinking by model, not by a reasoning-effort option." },
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Renders a tool-result payload as transcript text. The AI SDK wraps results
 * in an `{ type, value }` envelope; a bare value is accepted too so the V4
 * prompt and ModelMessage shapes cannot drift.
 */
function toolResultTranscriptText(output: unknown): string {
  const value = isRecordValue(output) && "value" in output ? output.value : output;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function flattenPromptMessage(message: unknown): unknown {
  if (!isRecordValue(message)) return message;
  const content = message.content;
  if (!Array.isArray(content)) return message;

  if (message.role === "tool") {
    const results = content
      .filter(isRecordValue)
      .filter((part) => part.type === "tool-result");
    // No recognizable result: leave the message untouched so the assertion
    // still rejects it instead of silently dropping the content.
    if (results.length === 0) return message;
    const text = results
      .map(
        (part) =>
          `[Tool result for ${String(part.toolName)}: ${toolResultTranscriptText(part.output)}]`
      )
      .join("\n");
    return { ...message, role: "user", content: [{ type: "text", text }] };
  }

  if (message.role === "assistant") {
    const parts = content.map((part) => {
      if (!isRecordValue(part)) return part;
      if (part.type === "tool-call") {
        const args = part.input ?? part.args;
        return {
          type: "text",
          text: `[Tool invocation: ${String(part.toolName)}(${JSON.stringify(args)})]`,
        };
      }
      if (part.type === "reasoning") {
        const text = typeof part.text === "string" ? part.text : "";
        return { type: "text", text: `[Reasoning: ${text}]` };
      }
      return part;
    });
    return { ...message, content: parts };
  }

  return message;
}

/**
 * Spec §7.2 — flattens the history parts a web-session model CAN read as text
 * (tool calls, tool results, reasoning) into transcript text, so a chat that
 * previously used tools stays usable after switching to DeepSeek Web.
 * Genuinely unserviceable parts (binary attachments) are left untouched for
 * `assertTextOnlyPrompt` to reject — nothing is silently dropped.
 *
 * Exported for the chat route, which applies the same flattening to the model
 * messages it builds, so both layers share one rule set.
 */
export function flattenWebProviderHistory(prompt: unknown): unknown[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.map(flattenPromptMessage);
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
 * the protocol spike (Spec §13.1). The shape below is the patch-operation
 * grammar the reference implementations emit (`v.response`, `p`/`o`/`v` path
 * patches, `FINISHED`). The spike must confirm or correct it before enablement.
 * Until then, tests pin the *contract*: a THINK/RESPONSE delta yields the
 * matching part, FINISHED closes the turn, and any other recognized-but-
 * unhandled JSON surface is a typed `protocol_error` rather than a silent drop.
 *
 * `parseStreamFrames` has already rejected non-JSON frames as a typed
 * `protocol_error`, so any string arriving here is valid JSON.
 */
type FrameOutcome =
  // A content delta carries only the appended text; `doStream` emits it on the
  // active segment (the segment switch set it). A segment switch carries an
  // empty body but names the next segment.
  | { kind: "delta"; segment: "reasoning" | "text"; text: string }
  | { kind: "finished" }
  | { kind: "metadata" };

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

  // Initial value frame: `v.response` with the fragment list, and no `p` (a
  // patch frame carries both `p` and `v`). The last declared fragment's type
  // sets the active segment so the following content deltas are emitted
  // correctly (Spec A5: THINK→reasoning, RESPONSE→text). The frame carries no
  // stream text of its own, but the segment switch is a delta with an empty
  // body, which `doStream` applies before continuing.
  if ("v" in obj && !("p" in obj)) {
    const response = obj.v as Record<string, unknown>;
    const fragments = (response.response as Record<string, unknown> | undefined)?.fragments;
    if (Array.isArray(fragments) && fragments.length > 0) {
      const last = fragments[fragments.length - 1] as Record<string, unknown> | undefined;
      const type = typeof last?.type === "string" ? (last.type as string) : "";
      if (type === "THINK" || type === "REASONING") return { kind: "delta", segment: "reasoning", text: "" };
      if (type === "RESPONSE" || type === "ANSWER") return { kind: "delta", segment: "text", text: "" };
    }
    return { kind: "metadata" };
  }

  const path = typeof obj.p === "string" ? obj.p : "";
  const op = typeof obj.o === "string" ? obj.o : "";
  const value = obj.v;

  if (path === "response/status" && op === "SET" && value === "FINISHED") {
    return { kind: "finished" };
  }

  if (path === "response/search_results") {
    // Trailing citation metadata; not rendered (Spec A5). Dropped, not an error.
    return { kind: "metadata" };
  }

  if (
    path === "response/fragments/-1/content" &&
    op === "APPEND" &&
    typeof value === "string"
  ) {
    // Delta on the active fragment (THINK or RESPONSE). The segment is tracked by
    // the active-fragment switch, not by this frame (which never names it).
    return { kind: "delta", segment: "text", text: value };
  }

  if (
    path === "response/fragments" &&
    op === "APPEND" &&
    isRecordValue(value) &&
    typeof value.type === "string"
  ) {
    // Segment switch: the new fragment's type decides whether subsequent deltas
    // are reasoning or text. The contract only needs the *type* to classify the
    // next deltas; we return it as the delta segment so the caller switches.
    const type = value.type;
    if (type === "THINK" || type === "REASONING") return { kind: "delta", segment: "reasoning", text: "" };
    if (type === "RESPONSE" || type === "ANSWER") return { kind: "delta", segment: "text", text: "" };
    return { kind: "metadata" };
  }

  // An explicit close event or an unknown-but-structured frame is unverified
  // output — surface it as a protocol error rather than silently dropping it
  // into a partial successful response (Spec §7.2).
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
    const sanitizedPrompt = this.sanitizePrompt(optionsRecord.prompt);
    this.assertTextOnlyPrompt(sanitizedPrompt);
    const messages = this.extractTextMessages(sanitizedPrompt);
    const callerSignal = optionsRecord.abortSignal;

    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;

    // Spec §11.3: `createTextStream` throws before any stream exists for a
    // classified upstream failure — including the HTML/challenge response that
    // is an explicit trip condition — so the stream catch below never sees it.
    // Record it here and re-throw unchanged.
    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = await this.adapter.createTextStream(
        identity,
        { messages, modelId: this.modelId },
        signal
      );
    } catch (error) {
      if (error instanceof AdapterRequestError) {
        await recordProtocolFailure(this.provider, error.failure.code);
      }
      throw error;
    }

    let cancelled = false;
    // Captured here: inside the stream source, `this` is the underlying source
    // object, not the model.
    const providerId = this.provider;
    const modelId = this.modelId;
    const stream = new ReadableStream<V4StreamPart>({
      async start(streamController) {
        const emit = (part: V4StreamPart) => {
          if (!cancelled) streamController.enqueue(part);
        };
        emit({ type: "stream-start", warnings });
        emit({ type: "text-start", id: TEXT_PART_ID });
        let reasoningOpen = false;
        let finished = false;
        // The active fragment segment, switched by THINK↔RESPONSE frames. Content
        // deltas are emitted on this segment (Spec A5: THINK→reasoning-delta,
        // RESPONSE→text-delta); the initial `v.response` frame seeds it from the
        // last declared fragment's type.
        let activeSegment: "reasoning" | "text" = "text";
        const openReasoning = () => {
          if (!reasoningOpen) {
            reasoningOpen = true;
            emit({ type: "reasoning-start", id: REASONING_PART_ID });
          }
        };
        const closeReasoning = () => {
          if (reasoningOpen) {
            reasoningOpen = false;
            emit({ type: "reasoning-end", id: REASONING_PART_ID });
          }
        };

        try {
          for await (const payload of parseStreamFrames(upstream, {}, signal)) {
            if (cancelled) break;
            const frame = classifyFrame(payload);
            if (frame.kind === "finished") {
              finished = true;
              // Drain trailing metadata for the FINISHED_DRAIN_MS grace, then stop.
              break;
            }
            if (frame.kind === "metadata") continue;
            // A segment switch has an empty body; it only changes the active
            // segment and opens/closes the reasoning block accordingly.
            if (frame.kind === "delta" && frame.text.length === 0) {
              activeSegment = frame.segment;
              if (frame.segment === "reasoning") openReasoning();
              else closeReasoning();
              continue;
            }
            if (frame.kind === "delta") {
              if (activeSegment === "reasoning") {
                openReasoning();
                emit({ type: "reasoning-delta", id: REASONING_PART_ID, delta: frame.text });
              } else {
                closeReasoning();
                emit({ type: "text-delta", id: TEXT_PART_ID, delta: frame.text });
              }
            }
          }
          if (cancelled) return;
          // Spec A5: hold the connection open briefly after FINISHED so any
          // trailing (metadata-only) frames flush before the turn closes.
          if (finished) await sleep(FINISHED_DRAIN_MS);
          closeReasoning();
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
            const code = error instanceof AdapterRequestError ? error.failure.code : "protocol_error";
            if (
              code === "protocol_error" ||
              code === "unsupported_protocol"
            ) {
              await recordProtocolFailure(providerId, code);
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

    // `modelId` is referenced for clarity in any future per-model logging.
    void modelId;
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
    let reasoning = "";
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
        } else if (value?.type === "reasoning-delta") {
          reasoning += value.delta;
        } else if (value?.type === "finish") {
          finishReason = value.finishReason;
          usage = value.usage;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const content: V4ContentBlock[] = [];
    if (reasoning.length > 0) content.push({ type: "reasoning", text: reasoning });
    content.push({ type: "text", text });

    return {
      content,
      finishReason,
      usage,
      warnings,
    };
  }

  /**
   * Flattens history parts a web-session model can read as text (tool calls,
   * tool results, reasoning) before the text-only assertion runs, so a chat
   * that previously used tools/attachments stays usable after switching to
   * DeepSeek Web (Spec §7.2). Binary attachments are left in place for the
   * assertion to reject.
   */
  private sanitizePrompt(prompt: unknown): unknown[] {
    return flattenWebProviderHistory(prompt);
  }

  /**
   * Spec §7.2: the web-session protocol supports text only. After
   * {@link sanitizePrompt} has flattened the serviceable parts, anything
   * still non-text (a binary attachment) cannot be served faithfully —
   * dropping it would silently answer a question about content the model
   * never saw. Reject up front with a typed `unsupported_protocol` error that
   * names the part type.
   */
  private assertTextOnlyPrompt(prompt: unknown): void {
    if (!Array.isArray(prompt)) return;
    for (const message of prompt) {
      if (typeof message !== "object" || message === null) continue;
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (typeof part !== "object" || part === null) continue;
        const type = (part as { type?: unknown }).type;
        if (type !== "text") {
          throw failureError(
            "unsupported_protocol",
            `Web Provider supports text messages only; a "${String(type)}" part cannot be served. Remove the attachment to continue.`
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
