// @vitest-environment node
/**
 * The Projects resume endpoint's contract.
 *
 * Bug this pins: the Projects route publishes its SSE stream to the registry
 * (`publishStream`), but there was no endpoint to re-attach to it and the client
 * never asked. So a tab switch or reload left the run apparently dead, and the
 * next send was refused with 409 "Session stream is already in progress" until
 * the registry entry expired.
 *
 * Contract: 204 when idle (client falls back to persisted messages), 200 + SSE
 * when a stream is live, and a stale pointer is cleared so the 409 cannot stick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProjectSession = vi.fn();
const releaseProjectSessionStream = vi.fn();
const attachStream = vi.fn();

vi.mock("@/lib/project-service", () => ({
  getProjectSession: (...args: unknown[]) => getProjectSession(...args),
  releaseProjectSessionStream: (...args: unknown[]) =>
    releaseProjectSessionStream(...args),
}));

vi.mock("@/lib/ai/stream-registry", () => ({
  attachStream: (...args: unknown[]) => attachStream(...args),
  streamRegistry: { has: () => false },
}));

import { GET } from "@/app/api/projects/chat/[sessionId]/stream/route";

function req() {
  return new Request("http://localhost/api/projects/chat/sess_1/stream") as never;
}
function params(sessionId = "sess_1") {
  return { params: Promise.resolve({ sessionId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/projects/chat/[sessionId]/stream", () => {
  it("answers 204 when the session has no active stream", async () => {
    getProjectSession.mockResolvedValue({ id: "sess_1", activeStreamId: null });
    const res = await GET(req(), params());
    expect(res.status).toBe(204);
    expect(attachStream).not.toHaveBeenCalled();
  });

  it("answers 204 when the session does not exist", async () => {
    getProjectSession.mockResolvedValue(null);
    const res = await GET(req(), params());
    expect(res.status).toBe(204);
  });

  it("answers 204 and clears a stale pointer", async () => {
    // The DB says a stream is active, but the registry no longer has it (the run
    // finished, or the entry was evicted). Leaving the pointer set is what makes
    // the next send fail with 409 forever, so it must be released.
    getProjectSession.mockResolvedValue({ id: "sess_1", activeStreamId: "s_old" });
    attachStream.mockReturnValue(null);

    const res = await GET(req(), params());

    expect(res.status).toBe(204);
    expect(releaseProjectSessionStream).toHaveBeenCalledWith("sess_1", "s_old");
  });

  it("answers 200 with an SSE body when a stream is live", async () => {
    getProjectSession.mockResolvedValue({ id: "sess_1", activeStreamId: "s_live" });
    attachStream.mockReturnValue(
      new ReadableStream<string>({
        start(controller) {
          controller.enqueue("data: hello\n\n");
          controller.close();
        },
      })
    );

    const res = await GET(req(), params());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // The registry hands out strings; the body must be bytes.
    const text = await res.text();
    expect(text).toBe("data: hello\n\n");
  });

  it("answers 204 rather than throwing when the session lookup fails", async () => {
    getProjectSession.mockRejectedValue(new Error("db down"));
    const res = await GET(req(), params());
    expect(res.status).toBe(204);
  });
});
