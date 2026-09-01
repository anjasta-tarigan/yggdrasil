import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/chat/[id]/stream/route";
import { POST as POST_STOP } from "@/app/api/chat/[id]/stop/route";
import {
  publishStream,
  cancelStream,
  resetStreamRegistry,
  activeStreamIds,
} from "@/lib/ai/stream-registry";

// ── Mock the DB layer ──────────────────────────────────────────────
// The endpoints are thin; the tests pin their routing logic (204 vs
// 200, stale-stop guard, partial persistence) against a controlled
// pointer store, not real SQLite.

const mocks = vi.hoisted(() => ({
  getActiveStreamId: vi.fn(),
  setActiveStreamId: vi.fn().mockResolvedValue(true),
  clearActiveStreamId: vi.fn().mockResolvedValue(undefined),
  getChat: vi.fn(),
  saveChat: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/chat-service", () => ({
  getActiveStreamIdDb: mocks.getActiveStreamId,
  setActiveStreamIdDb: mocks.setActiveStreamId,
  clearActiveStreamIdDb: mocks.clearActiveStreamId,
  getChatDb: mocks.getChat,
  saveChatDb: mocks.saveChat,
}));

vi.mock("@/lib/chat-storage", () => ({
  deriveTitle: () => "Test title",
}));

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mocks.getActiveStreamId.mockReset().mockResolvedValue(null);
  mocks.setActiveStreamId.mockReset().mockResolvedValue(true);
  mocks.clearActiveStreamId.mockReset().mockResolvedValue(undefined);
  mocks.getChat.mockReset().mockResolvedValue(null);
  mocks.saveChat.mockReset().mockResolvedValue(undefined);
  resetStreamRegistry();
});

afterEach(() => {
  resetStreamRegistry();
});

/** SSE string chunk stream. */
const sse = (events: string[]) => {
  let i = 0;
  return new ReadableStream<string>({
    pull(controller) {
      if (i < events.length) controller.enqueue(events[i++]);
      else controller.close();
    },
  });
};

describe("GET /api/chat/[id]/stream (resume)", () => {
  it("answers 204 when the chat has no active stream", async () => {
    mocks.getActiveStreamId.mockResolvedValue(null);
    const res = await GET(new Request("http://x"), params("chat-1"));
    expect(res.status).toBe(204);
  });

  it("answers 204 when the pointer references a finished stream", async () => {
    // Publish and let it finish.
    publishStream("s1", "chat-1", sse(["data: a\n\n"]));
    await new Promise((r) => setTimeout(r, 20));
    mocks.getActiveStreamId.mockResolvedValue("s1");
    const res = await GET(new Request("http://x"), params("chat-1"));
    expect(res.status).toBe(204);
    // Stale pointer gets cleared for next time (fire-and-forget in the
    // route — allow the microtask to settle first).
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.clearActiveStreamId).toHaveBeenCalledWith("chat-1", "s1");
  });

  it("re-attaches with a 200 stream when a generation is live", async () => {
    // Slow producer: stays live during the assertion.
    const events = Array.from({ length: 20 }, (_, i) => `data: c${i}\n\n`);
    let i = 0;
    const live = new ReadableStream<string>({
      async pull(controller) {
        if (i < events.length) {
          controller.enqueue(events[i++]);
          await new Promise((r) => setTimeout(r, 5));
        } else controller.close();
      },
    });
    publishStream("s2", "chat-1", live);
    mocks.getActiveStreamId.mockResolvedValue("s2");

    const res = await GET(new Request("http://x"), params("chat-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // The body replays what already streamed then continues live.
    const text = await new Response(res.body).text();
    expect(text).toContain("data: c0");
    expect(text).toContain("data: c19");
  });

  it("treats a DB lookup failure as idle (client still boots)", async () => {
    mocks.getActiveStreamId.mockRejectedValue(new Error("db down"));
    const res = await GET(new Request("http://x"), params("chat-1"));
    expect(res.status).toBe(204);
  });
});

describe("POST /api/chat/[id]/stop", () => {
  const stopBody = (payload: unknown) =>
    new Request("http://x/stop", {
      method: "POST",
      body: JSON.stringify(payload ?? {}),
      headers: { "Content-Type": "application/json" },
    });

  const assistantMsg = {
    id: "a-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "partial answer" }],
  };

  it("is a no-op success when no stream is active", async () => {
    const res = await POST_STOP(stopBody({}), params("chat-1"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.stopped).toBe(false);
  });

  it("cancels a live stream and clears the pointer", async () => {
    const events = Array.from({ length: 30 }, () => "data: tick\n\n");
    let i = 0;
    const live = new ReadableStream<string>({
      async pull(controller) {
        if (i < events.length) {
          controller.enqueue(events[i++]);
          await new Promise((r) => setTimeout(r, 5));
        } else controller.close();
      },
    });
    publishStream("s3", "chat-1", live);
    mocks.getActiveStreamId.mockResolvedValue("s3");

    const res = await POST_STOP(stopBody({}), params("chat-1"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.stopped).toBe(true);
    expect(mocks.clearActiveStreamId).toHaveBeenCalledWith("chat-1", "s3");
    expect(activeStreamIds()).toEqual([]);
  });

  it("ignores a stale stop naming an older stream id", async () => {
    // Slow producer so the stream is still live when the stop lands.
    const events = Array.from({ length: 20 }, () => "data: tick\n\n");
    let i = 0;
    const live = new ReadableStream<string>({
      async pull(controller) {
        if (i < events.length) {
          controller.enqueue(events[i++]);
          await new Promise((r) => setTimeout(r, 5));
        } else controller.close();
      },
    });
    publishStream("s-new", "chat-1", live);
    mocks.getActiveStreamId.mockResolvedValue("s-new");

    const res = await POST_STOP(
      stopBody({ activeStreamId: "s-old" }),
      params("chat-1")
    );
    const data = await res.json();
    expect(data.stopped).toBe(false);
    expect(data.stale).toBe(true);
    // The live stream is untouched.
    expect(activeStreamIds().map((e) => e.streamId)).toEqual(["s-new"]);
    cancelStream("s-new"); // cleanup
  });

  it("persists the client's partial assistant message before canceling", async () => {
    const events = Array.from({ length: 30 }, () => "data: tick\n\n");
    let i = 0;
    const live = new ReadableStream<string>({
      async pull(controller) {
        if (i < events.length) {
          controller.enqueue(events[i++]);
          await new Promise((r) => setTimeout(r, 5));
        } else controller.close();
      },
    });
    publishStream("s4", "chat-1", live);
    mocks.getActiveStreamId.mockResolvedValue("s4");
    // Existing persisted history: the partial must merge into it, not
    // replace it.
    mocks.getChat.mockResolvedValue({
      id: "chat-1",
      title: "Existing",
      updatedAt: 1,
      messages: [
        { id: "u-1", role: "user", parts: [{ type: "text", text: "q" }] },
      ],
    });

    const res = await POST_STOP(
      stopBody({ assistantMessage: assistantMsg }),
      params("chat-1")
    );
    expect(res.status).toBe(200);
    expect(mocks.saveChat).toHaveBeenCalledTimes(1);
    const saved = mocks.saveChat.mock.calls[0][0];
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1]).toEqual(assistantMsg);
  });

  it("returns 500 when the pointer lookup fails", async () => {
    mocks.getActiveStreamId.mockRejectedValue(new Error("db down"));
    const res = await POST_STOP(stopBody({}), params("chat-1"));
    expect(res.status).toBe(500);
  });
});
