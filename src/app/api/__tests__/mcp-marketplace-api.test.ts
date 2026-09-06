import { describe, it, expect, vi, afterEach } from "vitest";
import { GET } from "../mcp/marketplace/route";
import { NextRequest } from "next/server";

// Mock secureFetch to return controlled Smithery responses in tests
vi.mock("@/lib/security/ssrf", () => ({
  secureFetch: vi.fn(async (url: string) => {
    if (url.includes("verified=true")) {
      return new Response(
        JSON.stringify({
          servers: [
            {
              id: "smithery-context7",
              qualifiedName: "upstash/context7-mcp",
              displayName: "Context7",
              description: "Documentation and code examples MCP server.",
              verified: true,
              remote: true,
              deploymentUrl: "https://context7.run.tools",
              useCount: 1500,
            },
            {
              id: "smithery-news",
              qualifiedName: "theagenttimes/news",
              displayName: "Agent News",
              description: "AI agent news search and ethical ratings.",
              verified: true,
              remote: true,
              deploymentUrl: "https://news.run.tools",
              useCount: 2200,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Unverified / mixed query
    return new Response(
      JSON.stringify({
        servers: [
          {
            id: "smithery-unverified",
            qualifiedName: "community/custom-tool",
            displayName: "Custom Tool",
            description: "An unverified community tool for testing.",
            verified: false,
            remote: false,
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
  assertSafeUrl: vi.fn(async (urlStr: string) => new URL(urlStr)),
}));

describe("GET /api/mcp/marketplace", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("queries Smithery and returns verified servers by default", async () => {
    const req = new NextRequest("http://localhost/api/mcp/marketplace");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe("smithery.ai");
    expect(data.verifiedOnly).toBe(true);
    expect(Array.isArray(data.servers)).toBe(true);
    expect(data.servers.length).toBeGreaterThan(0);
    for (const server of data.servers) {
      expect(server.verified).toBe(true);
    }
  });

  it("supports searching with q parameter", async () => {
    const req = new NextRequest("http://localhost/api/mcp/marketplace?q=context7");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.servers.length).toBeGreaterThan(0);
    expect(data.servers[0].qualifiedName).toBe("upstash/context7-mcp");
  });

  it("filters by category when specified", async () => {
    const req = new NextRequest("http://localhost/api/mcp/marketplace?category=development");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    for (const item of data.servers) {
      expect(item.category).toBe("development");
    }
  });

  it("returns community unverified servers when verifiedOnly=false", async () => {
    const req = new NextRequest("http://localhost/api/mcp/marketplace?verifiedOnly=false");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.verifiedOnly).toBe(false);
  });
});
