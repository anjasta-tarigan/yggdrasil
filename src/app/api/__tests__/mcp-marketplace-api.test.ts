import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "../mcp/marketplace/route";
import { NextRequest } from "next/server";

describe("GET /api/mcp/marketplace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns curated presets when no query is provided", async () => {
    const req = new NextRequest("http://localhost/api/mcp/marketplace");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.presets)).toBe(true);
    expect(data.presets.length).toBeGreaterThan(0);
  });

  it("filters presets by category", async () => {
    const req = new NextRequest(
      "http://localhost/api/mcp/marketplace?category=databases"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    for (const item of data.presets) {
      expect(item.category).toBe("databases");
    }
  });

  it("filters presets by search query", async () => {
    const req = new NextRequest(
      "http://localhost/api/mcp/marketplace?q=postgres"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    for (const item of data.presets) {
      const hay = `${item.name} ${item.description}`.toLowerCase();
      expect(hay).toContain("postgres");
    }
  });

  it("returns empty presets array for unknown category", async () => {
    const req = new NextRequest(
      "http://localhost/api/mcp/marketplace?category=nonexistent"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.presets).toEqual([]);
  });

  it("falls back to presets only when community registry fetch fails", async () => {
    const req = new NextRequest(
      "http://localhost/api/mcp/marketplace?q=anything&includeCommunity=1"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.presets)).toBe(true);
    // No community flag on preset entries (no crash)
    for (const item of data.presets) {
      expect(item.isCommunity).toBeFalsy();
    }
  });

  it("marks community items with isCommunity when registry returns data", async () => {
    const req = new NextRequest(
      "http://localhost/api/mcp/marketplace?q=test&includeCommunity=1"
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    const communityItems = data.presets.filter((p: any) => p.isCommunity);
    for (const item of communityItems) {
      expect(item.isCommunity).toBe(true);
    }
  });
});
