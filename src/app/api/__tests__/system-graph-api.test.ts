import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/system/graph/route";

/**
 * The graph endpoint is a thin adapter: validate query params, pass
 * them as filters, and shape errors. The graph logic itself is covered
 * by lib/memory/__tests__/graph.test.ts against real SQLite; here the
 * DB layer is mocked so only the adapter contract is pinned.
 */

const mocks = vi.hoisted(() => ({
  getKnowledgeGraph: vi.fn(),
}));

vi.mock("@/lib/memory/graph", () => ({
  getKnowledgeGraph: mocks.getKnowledgeGraph,
}));

const graphPayload = {
  nodes: [],
  edges: [],
  truncated: false,
  stats: {
    semanticCount: 0,
    episodicCount: 0,
    relationCount: 0,
    byRelationType: {},
    topHubs: [],
    topTags: [],
  },
};

const req = (qs: string) => new Request(`http://x/api/system/graph${qs}`);

beforeEach(() => {
  mocks.getKnowledgeGraph.mockReset();
});

describe("GET /api/system/graph", () => {
  it("passes no filters for a bare request", async () => {
    mocks.getKnowledgeGraph.mockResolvedValue(graphPayload);
    const res = await GET(req(""));
    expect(res.status).toBe(200);
    expect(mocks.getKnowledgeGraph).toHaveBeenCalledWith({
      maxNodes: undefined,
      filters: {},
    });
  });

  it("forwards all filters and maxNodes", async () => {
    mocks.getKnowledgeGraph.mockResolvedValue(graphPayload);
    const res = await GET(
      req("?maxNodes=50&relationTypes=associative_link,consolidated_into&nodeTypes=semantic&search=volcano")
    );
    expect(res.status).toBe(200);
    expect(mocks.getKnowledgeGraph).toHaveBeenCalledWith({
      maxNodes: 50,
      filters: {
        relationTypes: ["associative_link", "consolidated_into"],
        nodeTypes: ["semantic"],
        search: "volcano",
      },
    });
  });

  it("trims and drops empty csv segments", async () => {
    mocks.getKnowledgeGraph.mockResolvedValue(graphPayload);
    await GET(req("?relationTypes=%20a%20,,b&search=%20%20"));
    expect(mocks.getKnowledgeGraph).toHaveBeenCalledWith({
      maxNodes: undefined,
      filters: { relationTypes: ["a", "b"] },
    });
  });

  it("rejects maxNodes out of range", async () => {
    const res = await GET(req("?maxNodes=5"));
    expect(res.status).toBe(400);
    const res2 = await GET(req("?maxNodes=501"));
    expect(res2.status).toBe(400);
    expect(mocks.getKnowledgeGraph).not.toHaveBeenCalled();
  });

  it("rejects invalid nodeTypes values", async () => {
    const res = await GET(req("?nodeTypes=semantic,working"));
    expect(res.status).toBe(400);
    expect(mocks.getKnowledgeGraph).not.toHaveBeenCalled();
  });

  it("answers 500 when the graph build throws", async () => {
    mocks.getKnowledgeGraph.mockRejectedValue(new Error("db down"));
    const res = await GET(req(""));
    expect(res.status).toBe(500);
  });
});
