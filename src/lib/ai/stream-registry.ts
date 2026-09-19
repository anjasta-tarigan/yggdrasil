/**
 * In-process resumable stream registry.
 *
 * Implements the server half of the AI SDK "Chatbot Resume Streams"
 * contract (https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)
 * for a single-process deployment: instead of the guide's Redis-backed
 * `resumable-stream` package, the published SSE stream is kept alive in
 * this module and re-served to reconnecting clients, while the chat row
 * records the activeStreamId in SQLite.
 *
 * Architecture: a replaying broadcast pump.
 * - The registry holds ONE reader on the published branch and appends
 *   every SSE chunk to an in-memory buffer.
 * - Each attacher gets a fresh ReadableStream that first replays the
 *   buffer (what streamed before it connected — the whole point of
 *   resumption), then receives live chunks. Without replay, a client
 *   reconnecting after the first token would silently lose history.
 * - The model never backpressures: the pump reads as fast as the
 *   producer writes; slow clients are buffered by their own stream.
 * - A client disconnecting only removes it from the forwarding set.
 * - Cancellation (stop endpoint / TTL sweeper) races the pump against a
 *   stop signal, then cancels the source.
 *
 * Memory bound: the buffer holds one chat turn's SSE payload. The SDK's
 * own onEnd save persists the final messages, so the buffer is dropped
 * when the entry settles; a 30-minute TTL guards runaway producers.
 *
 * Lifecycle:
 *   POST /api/chat             publishStream(streamId, chatId, branch)
 *                                — from consumeSseStream
 *   stream ends / errors       pump closes attachers, entry
 *                               self-removes; the route's onEnd clears
 *                               the chat's activeStreamId in SQLite
 *   GET /api/chat/[id]/stream  attachStream(streamId) → replay + live
 *                               reader, or null (endpoint answers 204)
 *   POST /api/chat/[id]/stop   cancelStream(streamId)
 */

/** One attached client's write end. */
type Attacher = {
  controller: ReadableStreamDefaultController<string>;
  closed: boolean;
};

type RegistryEntry = {
  streamId: string;
  chatId: string;
  controller: AbortController;
  createdAt: number;
  /** Every SSE chunk emitted so far, in order (replay source). */
  buffer: string[];
  /** Live attachers receiving each new chunk. */
  attachers: Set<Attacher>;
  /** True once the source closed; attach is then impossible. */
  finished: boolean;
  /** Resolves on cancel/evict; unblocks the pump's read race. */
  stopped: Promise<void>;
  stopSignal: () => void;
};

const LIVE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

const entries = new Map<string, RegistryEntry>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of entries) {
      // Self-removal on settle is the normal path (pump continuation);
      // this only catches zombie producers that never settle.
      if (now - entry.createdAt > LIVE_TTL_MS) {
        entries.delete(id);
        entry.stopSignal();
        try {
          entry.controller.abort();
        } catch (err) {
          console.debug("[stream-registry] AbortController double-abort:", err);
        }
      }
    }
    if (entries.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a sweep timer.
  if (typeof sweeper === "object" && sweeper && "unref" in sweeper) {
    (sweeper as unknown as { unref(): void }).unref();
  }
}

/**
 * Publish a stream for resumption. `sseStream` must be a branch that
 * stays readable after the HTTP response closes — the
 * `consumeSseStream` callback provides exactly that. The registry
 * becomes its sole reader, buffering and forwarding chunks.
 */
export function publishStream(
  streamId: string,
  chatIdOrStream: string | ReadableStream<string>,
  maybeSseStream?: ReadableStream<string>
): void {
  const chatId = typeof chatIdOrStream === "string" ? chatIdOrStream : streamId;
  const sseStream = (
    typeof chatIdOrStream === "string" ? maybeSseStream! : chatIdOrStream
  ) as ReadableStream<string>;

  const stale = entries.get(streamId);
  if (stale) cancelEntry(stale);

  const controller = new AbortController();
  let stopSignal: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stopSignal = resolve;
  });

  const entry: RegistryEntry = {
    streamId,
    chatId,
    controller,
    createdAt: Date.now(),
    buffer: [],
    attachers: new Set(),
    finished: false,
    stopped,
    stopSignal,
  };
  entries.set(streamId, entry);
  startSweeper();

  void (async () => {
    const reader = sseStream.getReader();
    try {
      for (;;) {
        // Read races cancellation so a runaway producer can always be
        // stopped: on stop, release and cancel the source ourselves.
        const read = await Promise.race([
          reader.read(),
          stopped.then(() => null),
        ]);
        if (read === null) {
          entry.finished = true;
          reader.releaseLock();
          await sseStream.cancel().catch((err) =>
            console.debug("[stream-registry] sseStream.cancel failed:", err)
          );
          return;
        }
        if (read.done) break;
        const chunk = read.value;
        // Buffer first (a later attacher must replay this), then
        // forward to everyone currently attached.
        entry.buffer.push(chunk);
        for (const attacher of entry.attachers) {
          if (attacher.closed) continue;
          try {
            attacher.controller.enqueue(chunk);
          } catch (err) {
            // Client went away between reads — drop it from the set.
            console.debug("[stream-registry] Attacher enqueue failed (client gone):", err);
            attacher.closed = true;
            entry.attachers.delete(attacher);
          }
        }
      }
      entry.finished = true;
    } catch (err) {
      // Source errored: the error part already reached clients, and
      // the route's onError clears the activeStreamId. Mark finished
      // so no new attacher joins a dead stream.
      console.debug("[stream-registry] Stream pump source errored:", err);
      entry.finished = true;
    } finally {
      // Close every live attacher: the generation is over.
      for (const attacher of entry.attachers) {
        if (!attacher.closed) {
          attacher.closed = true;
          try {
            attacher.controller.close();
          } catch (err) {
            // client already gone
            console.debug("[stream-registry] Attacher controller close failed:", err);
          }
        }
      }
      entry.attachers.clear();
      // Self-remove unless a cancel already did (idempotent either way).
      if (entries.get(streamId) === entry) {
        entries.delete(streamId);
      }
    }
  })();
}

/**
 * Attach a fresh reader to a live stream, or null when the id is
 * unknown/finished (the endpoint then answers 204 and the client falls
 * back to persisted messages).
 *
 * The returned stream first replays every chunk emitted since the
 * generation started, then streams live chunks. Canceling it only
 * removes this client — the source and other attachers are unaffected.
 */
export function attachStream(
  streamId: string
): ReadableStream<string> | null {
  const entry = entries.get(streamId);
  if (!entry || entry.finished) return null;

  const attacher: Attacher = {
    controller: null as unknown as ReadableStreamDefaultController<string>,
    closed: false,
  };
  const stream = new ReadableStream<string>({
    start(controller) {
      attacher.controller = controller;
      // Replay history first so a reconnecting client rebuilds the
      // full response-so-far before receiving live deltas.
      for (const chunk of entry.buffer) {
        controller.enqueue(chunk);
      }
      entry.attachers.add(attacher);
    },
    cancel() {
      attacher.closed = true;
      entry.attachers.delete(attacher);
    },
  });
  return stream;
}

/** Internal: tear an entry down (cancel path shared by API + supersede). */
function cancelEntry(entry: RegistryEntry): void {
  entries.delete(entry.streamId);
  entry.stopSignal(); // unblocks the pump's read race
  try {
    entry.controller.abort();
  } catch (err) {
    console.debug(`[stream-registry] Error: ${err instanceof Error ? err.message : String(err)}`);
    // ignore double-abort
  }
  for (const attacher of entry.attachers) {
    if (!attacher.closed) {
      attacher.closed = true;
      try {
        // Plain close: the client treats it as a completed response,
        // and the stop endpoint persists the partial message.
        attacher.controller.close();
      } catch (err) {
        console.debug(`[stream-registry] Error: ${err instanceof Error ? err.message : String(err)}`);
        // already gone
      }
    }
  }
  entry.attachers.clear();
}

/** Cancel the generation behind a stream and forget it. */
export function cancelStream(streamId: string): boolean {
  const entry = entries.get(streamId);
  if (!entry) return false;
  cancelEntry(entry);
  return true;
}

/** Check if a stream is actively registered and not finished. */
export function hasStream(streamId: string): boolean {
  const entry = entries.get(streamId);
  return Boolean(entry && !entry.finished);
}

/** Test/introspection hook: the currently live (chatId, streamId) pairs. */
export function activeStreamIds(): Array<{ chatId: string; streamId: string }> {
  return [...entries.values()].map((e) => ({
    chatId: e.chatId,
    streamId: e.streamId,
  }));
}

/** Test hook: drop everything (between-tests isolation). */
export function resetStreamRegistry(): void {
  for (const entry of [...entries.values()]) {
    cancelEntry(entry);
  }
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Stream registry facade matching both cancelStream and abort method conventions. */
export const streamRegistry = {
  abort: cancelStream,
  cancelStream,
  publishStream,
  attachStream,
  has: hasStream,
  hasStream,
  activeStreamIds,
  resetStreamRegistry,
};

