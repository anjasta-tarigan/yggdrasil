import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSearchModels = vi.fn();
const mockGetModelTree = vi.fn();
const mockGetModelInfo = vi.fn();

vi.mock("@/lib/models/hf-client", () => ({
  createHfClient: () => ({
    searchModels: mockSearchModels,
    getModelTree: mockGetModelTree,
    getModelInfo: mockGetModelInfo,
  }),
}));

const mockGetJob = vi.fn();
const mockRegistry = {
  createJob: vi.fn().mockReturnValue({
    id: "job_test_1",
    kind: "embedding",
    repo: "test/repo",
    variant: "model.onnx",
    estimatedBytes: 0,
    bytesDownloaded: 0,
    status: "pending",
    abortController: new AbortController(),
    createdAt: new Date().toISOString(),
  }),
  getJob: mockGetJob,
};

vi.mock("@/lib/models/jobs", () => ({
  getJobRegistry: () => mockRegistry,
  JobConflictError: class extends Error {
    readonly activeVariant: string;
    readonly activeJobId: string;
    constructor(variant: string, jobId: string) {
      super(`conflict ${variant} ${jobId}`);
      this.activeVariant = variant;
      this.activeJobId = jobId;
    }
  },
}));

vi.mock("@/lib/models/installer", () => ({
  planInstall: vi.fn().mockResolvedValue({
    repo: "test/repo",
    kind: "embedding",
    chosenVariant: "model.onnx",
    availableVariants: ["model.onnx"],
    files: [{ role: "graph", destinationRelPath: "model.onnx", sizeBytes: 0 }],
    totalBytes: 0,
  }),
  executeInstall: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/models/smoke", () => ({
  runSmokeTest: vi.fn(),
  ModelUnusableError: class extends Error {},
}));

const mockDeleteModel = vi.fn();
vi.mock("@/lib/models/store", () => ({
  deleteModel: (...args: unknown[]) => mockDeleteModel(...args),
}));

const mockWarmRerankerSession = vi.fn();
vi.mock("@/lib/memory/reranker", () => ({
  warmRerankerSession: () => mockWarmRerankerSession(),
  getRerankerDbSetting: () => null,
}));

import { GET as searchRoute } from "../search/route";
import { POST as inspectRoute } from "../inspect/route";
import { POST as installRoute } from "../install/route";
import { GET as jobGetRoute, DELETE as jobDeleteRoute } from "../install/[jobId]/route";
import { POST as deleteRoute } from "../delete/route";
import { POST as warmRoute } from "../reranker/warm/route";

const MOCK_TREE = [
  { path: "onnx/model.onnx", type: "file", size: 1000, lfs: { oid: "abc", size: 1000, pointerSize: 100 } },
  { path: "tokenizer.json", type: "file", size: 500, lfs: { oid: "def", size: 500, pointerSize: 50 } },
];

const MOCK_INFO = { id: "test/repo", tags: [] };

describe("/api/models routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("browses the ranked catalog when no query is provided", async () => {
    mockSearchModels.mockResolvedValue([
      { id: "test/repo", downloads: 100, likes: 5, rank: 1 },
    ]);

    const req = new Request("http://localhost/api/models/search");
    const res = await searchRoute(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(mockSearchModels).toHaveBeenCalledWith({ query: "", kind: "embedding", limit: undefined });
  });

  it("searches models with q parameter and returns results", async () => {
    mockSearchModels.mockResolvedValue([
      { id: "test/repo", downloads: 100, likes: 5 },
    ]);

    const req = new Request("http://localhost/api/models/search?q=test&kind=embedding");
    const res = await searchRoute(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(mockSearchModels).toHaveBeenCalledWith({ query: "test", kind: "embedding", limit: undefined });
  });

  it("rejects an invalid kind", async () => {
    const req = new Request("http://localhost/api/models/search?q=test&kind=bogus");
    const res = await searchRoute(req);
    expect(res.status).toBe(400);
    expect(mockSearchModels).not.toHaveBeenCalled();
  });

  it("clamps an oversized limit to the maximum", async () => {
    mockSearchModels.mockResolvedValue([]);

    const req = new Request("http://localhost/api/models/search?kind=reranker&limit=100000");
    const res = await searchRoute(req);
    expect(res.status).toBe(200);
    expect(mockSearchModels).toHaveBeenCalledWith({ query: "", kind: "reranker", limit: 200 });
  });

  it("inspects model and returns plan", async () => {
    mockGetModelTree.mockResolvedValue(MOCK_TREE);
    mockGetModelInfo.mockResolvedValue(MOCK_INFO);

    const req = new Request("http://localhost/api/models/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "test/repo", kind: "embedding" }),
    });

    const res = await inspectRoute(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.plan).toBeDefined();
    expect(body.plan.chosenVariant).toBe("model.onnx");
  });

  it("inspect rejects missing repo", async () => {
    const req = new Request("http://localhost/api/models/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "embedding" }),
    });

    const res = await inspectRoute(req);
    expect(res.status).toBe(400);
  });

  it("install returns jobId when plan succeeds", async () => {
    const req = new Request("http://localhost/api/models/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "test/repo", kind: "embedding" }),
    });

    const res = await installRoute(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.jobId).toBe("job_test_1");
    expect(body.status).toBe("pending");
  });

  it("install rejects missing repo", async () => {
    const req = new Request("http://localhost/api/models/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "embedding" }),
    });

    const res = await installRoute(req);
    expect(res.status).toBe(400);
  });

  it("job GET returns job status", async () => {
    mockGetJob.mockReturnValue({
      id: "job_test_1",
      status: "completed",
      bytesDownloaded: 0,
      estimatedBytes: 0,
      currentFile: undefined,
      error: undefined,
    });

    const req = new Request("http://localhost/api/models/install/job_test_1");
    const res = await jobGetRoute(req, { params: Promise.resolve({ jobId: "job_test_1" }) });
    expect(res.status).toBe(200);
  });

  it("job GET returns 404 for unknown job", async () => {
    mockGetJob.mockReturnValue(undefined);

    const req = new Request("http://localhost/api/models/install/unknown");
    const res = await jobGetRoute(req, { params: Promise.resolve({ jobId: "unknown" }) });
    expect(res.status).toBe(404);
  });

  it("job DELETE aborts and marks job as aborted", async () => {
    const abortController = new AbortController();
    mockGetJob.mockReturnValue({
      id: "job_test_1",
      status: "downloading",
      abortController,
    });

    const req = new Request("http://localhost/api/models/install/job_test_1", { method: "DELETE" });
    const res = await jobDeleteRoute(req, { params: Promise.resolve({ jobId: "job_test_1" }) });
    expect(res.status).toBe(200);
    expect(abortController.signal.aborted).toBe(true);
  });

  describe("POST /api/models/delete", () => {
    it("deletes a model cleanly when found", async () => {
      mockDeleteModel.mockReturnValue({ success: true, freedBytes: 1024 });

      const req = new Request("http://localhost/api/models/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "reranker", model: "cross-encoder--mmarco/model.onnx" }),
      });
      const res = await deleteRoute(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.freedBytes).toBe(1024);
      expect(mockDeleteModel).toHaveBeenCalledWith("reranker", "cross-encoder--mmarco/model.onnx");
    });

    it("returns 404 when model is not found", async () => {
      mockDeleteModel.mockReturnValue({ success: false, error: "Model not found" });

      const req = new Request("http://localhost/api/models/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "reranker", model: "missing" }),
      });
      const res = await deleteRoute(req);
      expect(res.status).toBe(404);
    });

    it("validates request payload", async () => {
      const req = new Request("http://localhost/api/models/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "invalid-kind" }),
      });
      const res = await deleteRoute(req);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/models/reranker/warm", () => {
    it("triggers speculative pre-warming", async () => {
      mockWarmRerankerSession.mockResolvedValue(true);
      const req = new Request("http://localhost/api/models/reranker/warm", { method: "POST" });
      const res = await warmRoute(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.warmed).toBe(true);
    });
  });
});
