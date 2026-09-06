import { describe, it, expect, vi, beforeEach } from "vitest";

const mockUpsert = vi.fn();

vi.mock("@/lib/chat-service", () => ({
  upsertMessageFeedbackDb: mockUpsert,
}));

// Dynamic import AFTER mock is set up
const { PATCH } = await import(
  "@/app/api/chats/[id]/messages/[messageId]/feedback/route"
);

const makeParams = (id: string, messageId: string) => ({
  params: Promise.resolve({ id, messageId }),
});

const req = (feedback: unknown) =>
  new Request("http://localhost/test", {
    method: "PATCH",
    body: JSON.stringify({ feedback }),
    headers: { "Content-Type": "application/json" },
  });

describe("PATCH /api/chats/[id]/messages/[messageId]/feedback", () => {
  beforeEach(() => {
    mockUpsert.mockReset().mockResolvedValue(true);
  });

  it("returns 200 for positive feedback", async () => {
    const res = await PATCH(req("positive"), makeParams("c1", "m1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mockUpsert).toHaveBeenCalledWith("m1", "positive");
  });

  it("returns 200 for negative feedback", async () => {
    const res = await PATCH(req("negative"), makeParams("c1", "m1"));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith("m1", "negative");
  });

  it("returns 200 for null (clear) feedback", async () => {
    const res = await PATCH(req(null), makeParams("c1", "m1"));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith("m1", null);
  });

  it("returns 400 for invalid feedback value", async () => {
    const res = await PATCH(req("bad"), makeParams("c1", "m1"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing feedback key", async () => {
    const badReq = new Request("http://localhost/test", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(badReq, makeParams("c1", "m1"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when message not found", async () => {
    mockUpsert.mockResolvedValue(false);
    const res = await PATCH(req("positive"), makeParams("c1", "no-msg"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON body", async () => {
    const badReq = new Request("http://localhost/test", {
      method: "PATCH",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await PATCH(badReq, makeParams("c1", "m1"));
    expect(res.status).toBe(400);
  });
});
