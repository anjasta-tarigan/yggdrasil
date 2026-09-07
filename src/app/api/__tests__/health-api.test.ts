import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "../health/route";

describe("Health API Handler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GET /api/health returns status 200 with status ok and version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "model-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("number");
    expect(typeof body.version).toBe("string");
  });
});
