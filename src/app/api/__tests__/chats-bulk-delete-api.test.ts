import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../chats/bulk-delete/route";

const mockBulkDelete = vi.fn();

vi.mock("@/lib/chat-service", () => ({
  deleteChatsBulkDb: (...args: unknown[]) => mockBulkDelete(...args),
}));

beforeEach(() => {
  mockBulkDelete.mockReset();
});

const req = (body: unknown) =>
  new Request("http://localhost/api/chats/bulk-delete", {
    method: "POST",
    body: JSON.stringify(body),
  });

describe("POST /api/chats/bulk-delete", () => {
  it("deletes a valid id list in one call and reports the count", async () => {
    mockBulkDelete.mockResolvedValueOnce(2);
    const res = await POST(req({ ids: ["a", "b"] }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.deleted).toBe(2);
    expect(mockBulkDelete).toHaveBeenCalledWith(["a", "b"]);
  });

  it("rejects an empty ids array", async () => {
    const res = await POST(req({ ids: [] }));
    expect(res.status).toBe(400);
  });

  it("rejects a missing ids array", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req(null))).status).toBe(400);
  });

  it("rejects non-string entries", async () => {
    const res = await POST(req({ ids: ["a", 42, "b"] }));
    expect(res.status).toBe(400);
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it("rejects empty or oversized string entries", async () => {
    expect((await POST(req({ ids: ["a", ""] }))).status).toBe(400);
    const long = "x".repeat(129);
    expect((await POST(req({ ids: [long] }))).status).toBe(400);
  });

  it("rejects more than 500 ids in one request", async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const res = await POST(req({ ids }));
    expect(res.status).toBe(400);
    expect(mockBulkDelete).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON body", async () => {
    const bad = new Request("http://localhost/api/chats/bulk-delete", {
      method: "POST",
      body: "not json{",
    });
    expect((await POST(bad)).status).toBe(400);
  });

  it("returns 500 when the transaction fails", async () => {
    mockBulkDelete.mockRejectedValueOnce(new Error("db locked"));
    const res = await POST(req({ ids: ["a"] }));
    expect(res.status).toBe(500);
  });
});
