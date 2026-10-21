import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/proactive/events", () => ({
  listUnreadEvents: vi.fn().mockResolvedValue([]),
  markAllEventsRead: vi.fn().mockResolvedValue(0),
  markEventRead: vi.fn().mockResolvedValue(true),
}));

import { GET, POST } from "../route";
import { POST as markOneRead } from "../[id]/read/route";

describe("event API request guards", () => {
  it("rejects remote event reads without authentication", async () => {
    const response = await GET(
      new Request("http://example.test/api/events", {
        headers: { "x-forwarded-for": "203.0.113.5" },
      })
    );
    expect(response.status).toBe(401);
  });

  it("requires a same-origin JSON request to mark all read", async () => {
    const response = await POST(
      new Request("http://localhost/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );
    expect(response.status).toBe(403);
  });

  it("rejects remote per-event mutations without authentication", async () => {
    const response = await markOneRead(
      new Request("http://example.test/api/events/id/read", {
        method: "POST",
        headers: {
          "x-forwarded-for": "203.0.113.5",
          "Origin": "http://example.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { params: Promise.resolve({ id: "evt_test" }) }
    );
    expect(response.status).toBe(401);
  });
});
