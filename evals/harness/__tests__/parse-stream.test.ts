import { describe, it, expect } from "vitest";
import { splitSseEvents, parseUiMessageStream, drainStreamToText } from "../parse-stream";
import { TRANSCRIPT_AGENTIC_SUCCESS } from "../transcripts";

describe("splitSseEvents", () => {
  it("splits a multi-event SSE stream on blank lines", () => {
    const sse = 'data: {"type":"start"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n';
    const events = splitSseEvents(sse);
    expect(events).toEqual(['{"type":"start"}', '{"type":"finish"}', "[DONE]"]);
  });

  it("normalises CRLF line endings", () => {
    const sse = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
    const events = splitSseEvents(sse);
    expect(events).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles multiple data: lines in a single event (joined with newline)", () => {
    // Pretty-printed JSON across two data lines.
    const sse = 'data: {"type":"start",\ndata:  "messageId":"x"}\n\n';
    const events = splitSseEvents(sse);
    expect(events).toEqual(['{"type":"start",\n "messageId":"x"}']);
  });

  it("ignores non-data lines and blank events", () => {
    const sse = ': comment\n\ndata: {"type":"start"}\n\n\n\ndata: {"type":"finish"}\n\n';
    const events = splitSseEvents(sse);
    expect(events).toEqual(['{"type":"start"}', '{"type":"finish"}']);
  });
});

describe("parseUiMessageStream", () => {
  it("parses the agentic-success transcript into typed chunks", () => {
    const chunks = parseUiMessageStream(TRANSCRIPT_AGENTIC_SUCCESS);
    // start, start-step, tool-input-start, tool-input-available,
    // tool-output-available, finish-step, message-metadata,
    // text-start, text-delta, text-end, finish  = 11 chunks ([DONE] skipped)
    expect(chunks).toHaveLength(11);
    expect(chunks[0].type).toBe("start");
    expect(chunks[1].type).toBe("start-step");
    expect(chunks[3].type).toBe("tool-input-available");
    expect(chunks[4].type).toBe("tool-output-available");
    expect(chunks[5].type).toBe("finish-step");
    expect(chunks[6].type).toBe("message-metadata");
    expect(chunks[10].type).toBe("finish");
  });

  it("drops the [DONE] sentinel", () => {
    const sse = 'data: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n';
    const chunks = parseUiMessageStream(sse);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("finish");
  });

  it("skips malformed JSON payloads without throwing", () => {
    const sse = 'data: {bad json}\n\ndata: {"type":"start"}\n\n';
    const chunks = parseUiMessageStream(sse);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].type).toBe("start");
  });

  it("returns an empty array for an empty stream", () => {
    expect(parseUiMessageStream("")).toEqual([]);
  });

  it("handles a stream with only whitespace", () => {
    expect(parseUiMessageStream("   \n\n  \n")).toEqual([]);
  });
});

describe("drainStreamToText", () => {
  it("concatenates a ReadableStream of Uint8Array into text", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"finish"}\n\n'));
        controller.close();
      },
    });
    const text = await drainStreamToText(stream);
    expect(text).toBe('data: {"type":"start"}\n\ndata: {"type":"finish"}\n\n');
  });

  it("handles a multi-byte character split across chunks", async () => {
    const encoder = new TextEncoder();
    // "é" is 2 bytes in UTF-8; split the bytes across two enqueues.
    const bytes = encoder.encode("é");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([bytes[0]]));
        controller.enqueue(new Uint8Array([bytes[1]]));
        controller.close();
      },
    });
    const text = await drainStreamToText(stream);
    expect(text).toBe("é");
  });
});
