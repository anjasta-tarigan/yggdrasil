import { describe, it, expect, vi } from "vitest";
import { stripStraySseTail, sanitizeNonStreamJsonFetch } from "../provider";

describe("stripStraySseTail", () => {
  it("strips a trailing `data: [DONE]` from a JSON body", () => {
    const body = '{"ok":true,"usage":{"total":53}}data: [DONE]\n\n';
    expect(stripStraySseTail(body)).toBe('{"ok":true,"usage":{"total":53}}');
  });

  it("strips repeated [DONE] markers with blank lines between them", () => {
    const body =
      '{"ok":true}data: [DONE]\n\ndata: [DONE]\n\n';
    expect(stripStraySseTail(body)).toBe('{"ok":true}');
  });

  it("tolerates `data:[DONE]` without space", () => {
    const body = '{"ok":true}data:[DONE]';
    expect(stripStraySseTail(body)).toBe('{"ok":true}');
  });

  it("tolerates an `event: done` style terminator", () => {
    const body = '{"ok":true}\n\nevent: done\n\n';
    expect(stripStraySseTail(body)).toBe('{"ok":true}');
  });

  it("leaves clean JSON bodies untouched", () => {
    const body = '{"ok":true}';
    expect(stripStraySseTail(body)).toBe(body);
  });

  it("leaves bodies without any [DONE] marker untouched", () => {
    const body = '{"partial": "no terminator here"';
    expect(stripStraySseTail(body)).toBe(body);
  });

  it("returns the original body when stripping would break JSON", () => {
    // Marker appears *inside* the JSON payload, not as a trailing frame.
    const body = '{"text":"data: [DONE] appears inside"}';
    expect(stripStraySseTail(body)).toBe(body);
  });

  it("returns original when the remaining prefix is not valid JSON", () => {
    const body = 'not-json-at-alldata: [DONE]';
    expect(stripStraySseTail(body)).toBe(body);
  });

  it("handles an empty body gracefully", () => {
    expect(stripStraySseTail("")).toBe("");
    expect(stripStraySseTail("data: [DONE]\n\n")).toBe("data: [DONE]\n\n");
  });
});

describe("sanitizeNonStreamJsonFetch", () => {
  it("cleans a non-streaming JSON response with a stray [DONE] tail", async () => {
    const rawBody = '{"ok":true}data: [DONE]\n\n';
    const mockResponse = new Response(rawBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse);
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sanitizeNonStreamJsonFetch(
      "http://localhost/v1/chat/completions",
      { method: "POST", body: '{"model":"m","messages":[]}' }
    );

    expect(await res.text()).toBe('{"ok":true}');
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost/v1/chat/completions",
      { method: "POST", body: '{"model":"m","messages":[]}' }
    );
    vi.unstubAllGlobals();
  });

  it("cleans even when a gateway mislabels non-streaming JSON as text/event-stream", async () => {
    const rawBody = '{"ok":true}data: [DONE]\n\n';
    const mockResponse = new Response(rawBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const res = await sanitizeNonStreamJsonFetch("http://localhost/v1", {
      body: '{"stream":false,"model":"m"}',
    });
    expect(await res.text()).toBe('{"ok":true}');
    vi.unstubAllGlobals();
  });

  it("passes real streaming responses (stream: true in request) through untouched", async () => {
    const rawBody = 'data: {"chunk":1}\n\ndata: [DONE]\n\n';
    const mockResponse = new Response(rawBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const res = await sanitizeNonStreamJsonFetch("http://localhost/v1", {
      body: '{"stream":true,"model":"m"}',
    });
    expect(await res.text()).toBe(rawBody);
    vi.unstubAllGlobals();
  });

  it("passes requests without a string body untouched (e.g. GETs)", async () => {
    const rawBody = '{"ok":true}';
    const mockResponse = new Response(rawBody, { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const res = await sanitizeNonStreamJsonFetch("http://localhost/v1/models", {
      method: "GET",
    });
    expect(await res.text()).toBe(rawBody);
    vi.unstubAllGlobals();
  });

  it("returns the original body when stripping would not yield JSON", async () => {
    const rawBody = 'not-jsondata: [DONE]';
    const mockResponse = new Response(rawBody, { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const res = await sanitizeNonStreamJsonFetch("http://localhost/v1", {
      body: '{"model":"m"}',
    });
    expect(await res.text()).toBe(rawBody);
    vi.unstubAllGlobals();
  });
});
