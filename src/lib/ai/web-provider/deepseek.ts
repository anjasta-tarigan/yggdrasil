import { env } from "@/env";
import { classifyFailure, type ClassifiedFailure } from "./adapter";
import type { UserAgentMode } from "./types";
import type { ModelEntry } from "../provider-config/schema";
import { syslog } from "@/lib/observability/log-store";

/**
 * UNVERIFIED — protocol spike must confirm each path, method, request shape,
 * and stream frame before enablement (Spec §13.1).
 *
 * These paths are the only upstream targets the adapter may dispatch to. They
 * are declared here, never accepted from a caller, registry, or the Settings UI
 * (Spec §7.1). The protocol spike (Spec §16.1–§16.3) replaces this constant once
 * a permitted stable contract is confirmed; nothing else in the adapter changes.
 */
export const DEEPSEEK_WEB_ENDPOINTS = {
  session: "/api/v0/users/current",
  models: "/api/v0/models",
  chat: "/api/v0/chat/completions",
} as const;

/** Fixed allowlist origin. Callers cannot supply or override it (Spec §7.1). */
export const DEEPSEEK_WEB_ORIGIN = "https://chat.deepseek.com";

/**
 * Sent when neither a saved custom nor a saved browser-captured User-Agent is
 * available (Spec §5.2 precedence step 3).
 */
export const DEEPSEEK_WEB_DEFAULT_USER_AGENT = "Yggdrasil-Client/1.0 (Web-Provider)";

const STREAM_DONE_SENTINEL = "[DONE]";

/** A classified failure plus optional safe, bounded retry metadata (Spec §14.4). */
export interface AdapterFailure extends ClassifiedFailure {
  ok: false;
  retryAfterSeconds?: number;
}

/**
 * Thrown by the streaming surface, which cannot return a value union. Carries
 * the same closed, sanitized failure the non-streaming methods return, so
 * callers never handle raw upstream errors (Spec §12).
 */
export class AdapterRequestError extends Error {
  readonly failure: AdapterFailure;

  constructor(failure: AdapterFailure) {
    super(failure.message);
    this.name = "AdapterRequestError";
    this.failure = failure;
  }
}

/**
 * Narrow structural input for the adapter's public methods, so they are
 * testable without a database-backed `WebProviderSession`.
 */
export interface AdapterRequestIdentity {
  userToken: string;
  userAgentMode?: UserAgentMode;
  selectedUserAgent?: string;
}

export interface StreamFrameOptions {
  /** Overrides `YGGDRASIL_WEB_PROVIDER_STREAM_IDLE_TIMEOUT_MS` (tests use a short value). */
  idleTimeoutMs?: number;
  /** Overrides `YGGDRASIL_WEB_PROVIDER_STREAM_FRAME_MAX_BYTES`. */
  frameMaxBytes?: number;
}

function toFailure(classified: ClassifiedFailure): AdapterFailure {
  return { ok: false, ...classified };
}

function requestError(failure: AdapterFailure): AdapterRequestError {
  return new AdapterRequestError(failure);
}

function protocolError(): AdapterRequestError {
  return requestError(toFailure(classifyFailure(new Response(null, { status: 502 }))));
}

function timeoutError(): AdapterRequestError {
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  return requestError(toFailure(classifyFailure(abortError)));
}

/** Parses a `Retry-After` delta-seconds header, clamped to the configured maximum. */
function parseRetryAfter(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds, env.YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS);
}

/** Builds a classified failure from a non-OK response, adding safe retry metadata. */
function failureFromResponse(response: Response): AdapterFailure {
  const failure = toFailure(classifyFailure(response));
  const retryAfterSeconds = parseRetryAfter(response);
  if (retryAfterSeconds !== undefined) failure.retryAfterSeconds = retryAfterSeconds;
  return failure;
}

/** True when the upstream answered with an HTML document instead of JSON. */
function isHtmlResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}

/**
 * Reads a response body up to `maxBytes`, aborting without buffering past the
 * cap (Rule 02: constant memory; Spec §8.5: 1 MiB discovery cap). The reader is
 * always released.
 */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) return null;

  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export class DeepSeekWebAdapter {
  /** Spec §5.2 precedence: saved custom → saved browser-captured → server default. */
  private resolveUserAgent(mode?: UserAgentMode, selectedUserAgent?: string): string {
    if (selectedUserAgent && (mode === "custom" || mode === "browser")) {
      return selectedUserAgent;
    }
    return DEEPSEEK_WEB_DEFAULT_USER_AGENT;
  }

  /**
   * Composes the 10-second attempt timeout with the caller's signal. Both the
   * attempt cap and any caller abort surface as `upstream_timeout`.
   */
  private buildSignal(callerSignal?: AbortSignal): AbortSignal {
    const attemptTimeout = AbortSignal.timeout(env.YGGDRASIL_WEB_PROVIDER_ATTEMPT_TIMEOUT_MS);
    if (!callerSignal) return attemptTimeout;
    return AbortSignal.any([attemptTimeout, callerSignal]);
  }

  private buildHeaders(identity: AdapterRequestIdentity, accept: string): Record<string, string> {
    // No incoming browser cookies and no arbitrary client headers are forwarded,
    // and the User-Agent value never reaches the log (Spec §7.1, §12).
    return {
      Authorization: `Bearer ${identity.userToken}`,
      "User-Agent": this.resolveUserAgent(identity.userAgentMode, identity.selectedUserAgent),
      Accept: accept,
    };
  }

  /** Sanitized failure logging: closed code and status class only (Spec §12). */
  private logFailure(operation: string, failure: AdapterFailure): void {
    syslog(
      "warn",
      "web-provider",
      `deepseek.${operation} failed code=${failure.code} statusClass=${Math.floor(failure.httpStatus / 100)}xx`
    );
  }

  /**
   * Side-effect-free credential validation (Spec §5.3, §6.3). A 3xx never
   * reaches here: `redirect: "error"` makes fetch reject, which classifies as a
   * network failure.
   */
  async validateSession(
    identity: AdapterRequestIdentity,
    signal?: AbortSignal
  ): Promise<{ ok: true } | AdapterFailure> {
    const url = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.session}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(identity, "application/json"),
        redirect: "error",
        signal: this.buildSignal(signal),
      });

      if (!response.ok) {
        const failure = failureFromResponse(response);
        this.logFailure("validateSession", failure);
        return failure;
      }

      if (isHtmlResponse(response)) {
        // A login page served with 200 is an expired session, not a success.
        const failure: AdapterFailure = toFailure(classifyFailure(new Response(null, { status: 401 })));
        this.logFailure("validateSession", failure);
        return failure;
      }

      return { ok: true };
    } catch (error) {
      const failure: AdapterFailure = toFailure(classifyFailure(error));
      this.logFailure("validateSession", failure);
      return failure;
    }
  }

  /**
   * Model discovery with deterministic normalization (Spec §8.3). An empty
   * catalog is a success, distinguishable from a failed request (Spec §8.4).
   */
  async discoverModels(
    identity: AdapterRequestIdentity,
    signal?: AbortSignal
  ): Promise<{ ok: true; models: ModelEntry[] } | AdapterFailure> {
    const url = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.models}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: this.buildHeaders(identity, "application/json"),
        redirect: "error",
        signal: this.buildSignal(signal),
      });

      if (!response.ok) {
        const failure = failureFromResponse(response);
        this.logFailure("discoverModels", failure);
        return failure;
      }

      if (isHtmlResponse(response)) {
        const failure: AdapterFailure = toFailure(classifyFailure(new Response(null, { status: 401 })));
        this.logFailure("discoverModels", failure);
        return failure;
      }

      const body = await readBoundedBody(response, env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_RESPONSE_BYTES);
      if (body === null) {
        const failure: AdapterFailure = toFailure(classifyFailure(new Response(null, { status: 502 })));
        this.logFailure("discoverModels", failure);
        return failure;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        const failure: AdapterFailure = toFailure(classifyFailure(new Response(null, { status: 502 })));
        this.logFailure("discoverModels", failure);
        return failure;
      }

      return { ok: true, models: this.normalizeModels(parsed) };
    } catch (error) {
      const failure: AdapterFailure = toFailure(classifyFailure(error));
      this.logFailure("discoverModels", failure);
      return failure;
    }
  }

  /**
   * Maps provider records to `ModelEntry` candidates. The record predicate is
   * deliberately generic: no model-family allowlist is assumed before provider
   * evidence (Spec §8.3).
   */
  private normalizeModels(parsed: unknown): ModelEntry[] {
    const rawList = Array.isArray((parsed as { data?: unknown } | null)?.data)
      ? ((parsed as { data: unknown[] }).data as unknown[])
      : [];

    const seen = new Set<string>();
    const models: ModelEntry[] = [];
    const maxModels = env.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_MODELS;

    for (const record of rawList) {
      if (models.length >= maxModels) break;
      if (typeof record !== "object" || record === null) continue;

      const candidate = record as { id?: unknown; name?: unknown };
      if (typeof candidate.id !== "string") continue;

      const modelId = candidate.id.trim();
      if (!modelId || seen.has(modelId)) continue;
      seen.add(modelId);

      const displayName = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : modelId;

      models.push({
        modelId,
        displayName,
        // Discovery never promotes a model to default (Spec §8.3, §15.15).
        isDefault: false,
        capabilities: {
          contextWindow: null,
          maxOutputTokens: null,
          // Text is the only verified modality for the first adapter release (Spec §7.2).
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalls: null,
          supportsReasoning: null,
        },
        capabilitySources: {
          inputModalities: "provider-metadata",
          outputModalities: "provider-metadata",
        },
      });
    }

    return models;
  }

  /**
   * Opens the upstream text stream. Returns the raw upstream body; pair it with
   * `parseStreamFrames` to normalize frames and enforce the frame and idle caps.
   * Non-OK responses throw an `AdapterRequestError` carrying the closed failure.
   */
  async createTextStream(
    identity: AdapterRequestIdentity,
    request: { prompt: string; messages: unknown[] },
    signal?: AbortSignal
  ): Promise<ReadableStream<Uint8Array>> {
    const url = `${DEEPSEEK_WEB_ORIGIN}${DEEPSEEK_WEB_ENDPOINTS.chat}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          ...this.buildHeaders(identity, "text/event-stream"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ stream: true, messages: request.messages }),
        redirect: "error",
        signal: this.buildSignal(signal),
      });
    } catch (error) {
      const failure: AdapterFailure = toFailure(classifyFailure(error));
      this.logFailure("createTextStream", failure);
      throw requestError(failure);
    }

    if (!response.ok) {
      const failure = failureFromResponse(response);
      this.logFailure("createTextStream", failure);
      throw requestError(failure);
    }

    if (isHtmlResponse(response)) {
      const failure: AdapterFailure = toFailure(classifyFailure(new Response(null, { status: 401 })));
      this.logFailure("createTextStream", failure);
      throw requestError(failure);
    }

    if (!response.body) {
      const failure: AdapterFailure = toFailure(classifyFailure(new Response(null, { status: 502 })));
      this.logFailure("createTextStream", failure);
      throw requestError(failure);
    }

    return response.body;
  }
}

/**
 * Normalizes an upstream SSE body into frame payloads. Terminates with a typed
 * `AdapterRequestError` on a malformed frame or a frame over the byte cap
 * (Spec §7.2: never silently discard), and with `upstream_timeout` when no bytes
 * arrive within the idle window (Spec §8.5). Always releases the source reader.
 */
export async function* parseStreamFrames(
  source: ReadableStream<Uint8Array>,
  options: StreamFrameOptions = {},
  signal?: AbortSignal
): AsyncGenerator<string, void, void> {
  const frameMaxBytes = options.frameMaxBytes ?? env.YGGDRASIL_WEB_PROVIDER_STREAM_FRAME_MAX_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? env.YGGDRASIL_WEB_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
  const reader = source.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let aborted = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    aborted = true;
    // Cancelling resolves a pending read, so the loop exits promptly.
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw timeoutError();
    }

    while (true) {
      const idle = new Promise<"idle">((resolve) => {
        idleTimer = setTimeout(() => resolve("idle"), idleTimeoutMs);
      });
      const outcome = await Promise.race([
        reader.read().then((result) => ({ kind: "read" as const, result })),
        idle.then(() => ({ kind: "idle" as const })),
      ]);
      clearTimeout(idleTimer);
      idleTimer = undefined;

      if (outcome.kind === "idle") {
        await reader.cancel().catch(() => undefined);
        throw timeoutError();
      }

      if (aborted) throw timeoutError();
      if (outcome.result.done) {
        // Flush any bytes the decoder held back, then process the final frame.
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(outcome.result.value, { stream: true });

      // CRLF and lone CR are valid SSE line terminators (WHATWG Server-Sent
      // Events), so normalize before splitting. A trailing CR is held back: it
      // may be the first half of a `\r\n` split across two chunks, and
      // normalizing it now would fabricate a frame boundary.
      const holdBackCr = buffer.endsWith("\r");
      const normalized = (holdBackCr ? buffer.slice(0, -1) : buffer).replace(/\r\n|\r/g, "\n");

      let terminator = normalized.indexOf("\n\n");
      let consumed = 0;
      while (terminator !== -1) {
        const rawFrame = normalized.slice(consumed, terminator);

        if (new TextEncoder().encode(rawFrame).byteLength > frameMaxBytes) throw protocolError();

        const payload = extractDataPayload(rawFrame);
        if (payload !== null) {
          if (payload === STREAM_DONE_SENTINEL) return;
          if (!isJsonPayload(payload)) throw protocolError();
          yield payload;
        }

        consumed = terminator + 2;
        terminator = normalized.indexOf("\n\n", consumed);
      }

      buffer = normalized.slice(consumed) + (holdBackCr ? "\r" : "");

      // An unterminated frame that already exceeds the cap is a protocol error.
      if (new TextEncoder().encode(buffer).byteLength > frameMaxBytes) throw protocolError();
    }

    // A final frame may arrive without its terminating blank line before the
    // upstream closes the stream; it is still validated, never silently dropped.
    const trailing = buffer.replace(/\r\n|\r/g, "\n").trim();
    if (trailing.length > 0) {
      if (new TextEncoder().encode(trailing).byteLength > frameMaxBytes) throw protocolError();
      const payload = extractDataPayload(trailing);
      if (payload !== null && payload !== STREAM_DONE_SENTINEL) {
        if (!isJsonPayload(payload)) throw protocolError();
        yield payload;
      }
    }
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
  }
}

/** Returns the `data:` payload of an SSE frame, or null for comments/heartbeats. */
function extractDataPayload(rawFrame: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawFrame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    dataLines.push(line.slice("data:".length).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n").trim();
}

function isJsonPayload(payload: string): boolean {
  try {
    JSON.parse(payload);
    return true;
  } catch {
    return false;
  }
}
