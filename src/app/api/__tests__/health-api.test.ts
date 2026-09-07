import { describe, it, expect } from "vitest";
import { GET } from "../health/route";

describe("Health API Handler", () => {
  it("GET /api/health returns status 200 with status ok and version", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("number");
    expect(typeof body.version).toBe("string");
  });
});
