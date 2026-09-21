/**
 * Parses the SSE byte stream emitted by the Projects chat route into typed
 * UI-message chunks.
 *
 * The route uses `toUIMessageStream`, so each SSE event is a `data:` line
 * whose payload is a single-line JSON object. Events are separated by a blank
 * line. The stream terminates with `data: [DONE]`.
 *
 * This parser is deliberately tolerant: malformed JSON or `[DONE]` sentinels
 * are skipped rather than throwing, so a partially-corrupt transcript still
 * yields the chunks that could be recovered.
 */
import type { UiMessageChunk } from "./contracts";

/**
 * Splits a raw SSE byte stream into its `data:` payloads.
 *
 * Per the SSE spec, events are delimited by a blank line (`\n\n`), and a
 * single event may carry multiple `data:` lines whose values are joined with
 * `\n`. The AI-SDK emits one `data:` line per event, but we honour the spec
 * so pretty-printed JSON (if ever produced) round-trips correctly.
 */
export function splitSseEvents(sseText: string): string[] {
  // Normalise CRLF → LF.
  const normalised = sseText.replace(/\r\n/g, "\n");
  // Events are separated by one or more blank lines.
  const events = normalised.split(/\n\n+/);
  const payloads: string[] = [];
  for (const event of events) {
    const dataLines = event
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) continue;
    // Per the SSE spec, strip exactly one leading U+0020 SPACE from each
    // data line value (the `data: ` prefix convention), then join multi-line
    // values with \n.
    const payload = dataLines
      .map((l) => {
        const rest = l.slice(5); // remove "data:"
        return rest.startsWith(" ") ? rest.slice(1) : rest;
      })
      .join("\n");
    payloads.push(payload);
  }
  return payloads;
}

/**
 * Parses a raw SSE byte stream into typed UI-message chunks.
 *
 * `[DONE]` sentinels are dropped. Unparseable payloads are skipped.
 */
export function parseUiMessageStream(sseText: string): UiMessageChunk[] {
  const chunks: UiMessageChunk[] = [];
  for (const payload of splitSseEvents(sseText)) {
    if (payload === "[DONE]") continue;
    try {
      chunks.push(JSON.parse(payload) as UiMessageChunk);
    } catch {
      // Skip unparseable payloads — recoverable corruption only.
      continue;
    }
  }
  return chunks;
}

/**
 * Concatenates a stream of Uint8Array chunks into a single string. Used when
 * consuming a live `Response.body` reader before parsing.
 */
export async function drainStreamToText(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode(); // flush
  } finally {
    reader.releaseLock();
  }
  return text;
}
