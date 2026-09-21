import { createHash } from "node:crypto";
import type { ProviderEntry } from "./provider-config/schema";
import { resolveApiKeys } from "./provider-config/store";

// Bounded process-local cursors, shared by model instances and SDK retries.
const cursors = new Map<string, { fingerprint: string; next: number }>();

/** Default gap between provider bytes before the socket is treated as dead. */
export const PROVIDER_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Options for {@link createRotatingProviderFetch}. */
export interface RotatingProviderFetchOptions {
  /**
   * Abort a streaming response when no bytes arrive for this long.
   *
   * This measures the socket, not the step: a model that is thinking but
   * connected keeps the connection open without sending bytes only if the
   * provider does not stream reasoning, and a tool running for minutes is not
   * part of this response at all. Both are the reason the SDK's `chunkMs`
   * watchdog cannot serve this purpose — it is armed on the step signal and is
   * reset only by output chunks, so it kills slow-but-alive steps and keeps
   * counting through tool execution.
   */
  idleMs?: number;
}

/**
 * Guards a response body so a silently dead provider socket fails instead of
 * hanging forever.
 *
 * Only applied to streaming responses (`text/event-stream`): a non-streaming
 * JSON response is read in one piece by the SDK, and wrapping it would add a
 * reader for no benefit.
 *
 * On idle it errors the consumer's stream with a message naming the timeout, so
 * the failure surfaces through the normal error path rather than looking like a
 * stop. Caller cancellation is preserved: the caller's signal is forwarded to
 * the source reader, and an abort rejects with the caller's reason.
 */
function guardIdleBody(
  body: ReadableStream<Uint8Array>,
  idleMs: number,
  callerSignal: AbortSignal | undefined,
  onIdle: (err: Error) => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const arm = () => {
        clear();
        timer = setTimeout(() => {
          timer = undefined;
          const err = new Error(
            `Provider stream idle for ${idleMs}ms — no bytes received; treating the connection as dead.`
          );
          onIdle(err);
          // Cancel the source so the socket is released, then surface the error.
          void reader.cancel(err).catch(() => undefined);
          controller.error(err);
        }, idleMs);
      };

      const onAbort = () => {
        clear();
        void reader.cancel(callerSignal?.reason).catch(() => undefined);
        controller.error(
          callerSignal?.reason ?? new DOMException("Aborted", "AbortError")
        );
      };
      callerSignal?.addEventListener("abort", onAbort, { once: true });

      void (async () => {
        try {
          arm();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              clear();
              controller.close();
              return;
            }
            arm();
            controller.enqueue(value);
          }
        } catch (err) {
          clear();
          // A caller abort surfaces here too; report the caller's reason so the
          // SDK classifies it as a cancellation rather than a provider fault.
          if (callerSignal?.aborted) {
            controller.error(
              callerSignal.reason ?? new DOMException("Aborted", "AbortError")
            );
          } else {
            controller.error(err);
          }
        } finally {
          callerSignal?.removeEventListener("abort", onAbort);
        }
      })();
    },
    cancel(reason) {
      clear();
      return reader.cancel(reason);
    },
  });
}

export function createRotatingProviderFetch(
  entry: ProviderEntry,
  transport: typeof fetch = fetch,
  options: RotatingProviderFetchOptions = {},
): typeof fetch {
  const idleMs = options.idleMs ?? PROVIDER_IDLE_TIMEOUT_MS;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const base = new URL(entry.baseUrl);
    if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`)) {
      throw new Error("Provider credentials cannot be sent outside the configured endpoint");
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const keys = await resolveApiKeys(entry);
    signal?.throwIfAborted();
    if (keys.length === 0) throw new Error(`Provider "${entry.id}" has no configured API keys`);

    const fingerprint = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
    const cursorId = `${entry.id}|${base.href}`;
    const previous = cursors.get(cursorId);
    const next = previous?.fingerprint === fingerprint ? previous.next % keys.length : 0;
    // No await between reading and advancing the cursor: concurrent calls take different turns.
    cursors.delete(cursorId);
    cursors.set(cursorId, { fingerprint, next: (next + 1) % keys.length });
    if (cursors.size > 100) cursors.delete(cursors.keys().next().value!);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("Authorization", `Bearer ${keys[next]}`);
    // Do not follow redirects with provider credentials, even within the same origin.
    const response = await transport(input, { ...init, headers, redirect: "error" });

    // Only streaming bodies can stall mid-response; a JSON body is read whole.
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      return response;
    }

    const guarded = guardIdleBody(
      response.body,
      idleMs,
      signal,
      (err) => {
        // Reuse the caller's error channel when there is one, so an idle
        // timeout reaches the SDK's onError path instead of vanishing.
        console.warn(`[provider-fetch] ${entry.id}: ${err.message}`);
      }
    );
    return new Response(guarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

