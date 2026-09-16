import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real module under test (no vi.mock here): these tests pin the slot
// isolation contract that keeps the reranker and an ONNX embedder from
// evicting each other on every memory search.
const mockSessionCreate = vi.fn();
function MockTensor(
  this: { type: string; data: unknown; dims: readonly number[] },
  type: string,
  data: unknown,
  dims: readonly number[]
) {
  this.type = type;
  this.data = data;
  this.dims = dims;
}

import {
  acquireOnnxSession,
  releaseOnnxSession,
  releaseAllOnnxSessions,
  isOnnxSessionLoaded,
  setOrtLoaderForTest,
  ONNX_SLOT_EMBEDDING,
  ONNX_SLOT_RERANKER,
  ONNX_SESSION_GLOBAL_KEY,
} from "../onnx-session";

/** A distinct fake session per creation so identity checks are meaningful. */
function fakeSession(id: string) {
  return {
    run: vi.fn(async () => ({ logits: { data: new Float32Array([id.length]) } })),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("onnx-session slot lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrtLoaderForTest(async () => ({
      InferenceSession: { create: mockSessionCreate },
      Tensor: MockTensor as never,
    }));
  });

  afterEach(() => {
    setOrtLoaderForTest(null);
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>)[ONNX_SESSION_GLOBAL_KEY];
  });

  it("reuses the loaded session for the same slot + model", async () => {
    const s1 = fakeSession("one");
    mockSessionCreate.mockResolvedValue(s1);

    const a = await acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/m.onnx");
    const b = await acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/m.onnx");

    expect(a).toBe(b);
    expect(mockSessionCreate).toHaveBeenCalledOnce();
  });

  it("keeps the reranker and embedder sessions alive at the same time", async () => {
    const embedderSession = fakeSession("embed");
    const rerankerSession = fakeSession("rerank");
    mockSessionCreate
      .mockResolvedValueOnce(embedderSession)
      .mockResolvedValueOnce(rerankerSession);

    await acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/embed.onnx");
    await acquireOnnxSession(ONNX_SLOT_RERANKER, "/rerank.onnx");

    // Both slots hold a live session — a search embeds then reranks.
    expect(isOnnxSessionLoaded(ONNX_SLOT_EMBEDDING)).toBe(true);
    expect(isOnnxSessionLoaded(ONNX_SLOT_RERANKER)).toBe(true);
    // Acquiring the reranker must NOT have released the embedder.
    expect(embedderSession.release).not.toHaveBeenCalled();
    expect(mockSessionCreate).toHaveBeenCalledTimes(2);
  });

  it("releases the slot's old session when its model changes", async () => {
    const first = fakeSession("first");
    const second = fakeSession("second");
    mockSessionCreate
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    await acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/a.onnx");
    await acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/b.onnx");

    expect(first.release).toHaveBeenCalledOnce();
    expect(mockSessionCreate).toHaveBeenCalledTimes(2);
    expect(isOnnxSessionLoaded(ONNX_SLOT_EMBEDDING)).toBe(true);
  });

  it("does not evict another slot when one slot switches models", async () => {
    const embedder = fakeSession("embed");
    const rerankerOld = fakeSession("rerank-old");
    const rerankerNew = fakeSession("rerank-new");
    mockSessionCreate
      .mockResolvedValueOnce(embedder)
      .mockResolvedValueOnce(rerankerOld)
      .mockResolvedValueOnce(rerankerNew);

    await acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/embed.onnx");
    await acquireOnnxSession(ONNX_SLOT_RERANKER, "/rerank-a.onnx");
    await acquireOnnxSession(ONNX_SLOT_RERANKER, "/rerank-b.onnx");

    expect(rerankerOld.release).toHaveBeenCalledOnce();
    expect(embedder.release).not.toHaveBeenCalled();
    expect(isOnnxSessionLoaded(ONNX_SLOT_EMBEDDING)).toBe(true);
  });

  it("deduplicates concurrent acquires for the same slot", async () => {
    const session = fakeSession("shared");
    mockSessionCreate.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return session;
    });

    const [a, b] = await Promise.all([
      acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/m.onnx"),
      acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/m.onnx"),
    ]);

    expect(a).toBe(b);
    expect(mockSessionCreate).toHaveBeenCalledOnce();
  });

  it("releaseAllOnnxSessions clears every slot", async () => {
    const embedder = fakeSession("embed");
    const reranker = fakeSession("rerank");
    mockSessionCreate
      .mockResolvedValueOnce(embedder)
      .mockResolvedValueOnce(reranker);

    await acquireOnnxSession(ONNX_SLOT_EMBEDDING, "/embed.onnx");
    await acquireOnnxSession(ONNX_SLOT_RERANKER, "/rerank.onnx");
    await releaseAllOnnxSessions();

    expect(embedder.release).toHaveBeenCalledOnce();
    expect(reranker.release).toHaveBeenCalledOnce();
    expect(isOnnxSessionLoaded(ONNX_SLOT_EMBEDDING)).toBe(false);
    expect(isOnnxSessionLoaded(ONNX_SLOT_RERANKER)).toBe(false);
  });

  it("releaseOnnxSession is a no-op for an empty slot", async () => {
    await expect(
      releaseOnnxSession(ONNX_SLOT_EMBEDDING)
    ).resolves.toBeUndefined();
    expect(mockSessionCreate).not.toHaveBeenCalled();
  });

  it("falls back to cpu when preferred execution provider fails to initialize", async () => {
    const sCpu = fakeSession("cpu-fallback");
    mockSessionCreate
      .mockRejectedValueOnce(new Error("DirectML initialization failed"))
      .mockResolvedValueOnce(sCpu);

    const session = await acquireOnnxSession(ONNX_SLOT_RERANKER, "/model-fallback.onnx", {
      executionProviders: ["directml", "cpu"],
    });

    expect(session).toBe(sCpu);
    expect(mockSessionCreate).toHaveBeenCalledTimes(2);
    expect(mockSessionCreate).toHaveBeenNthCalledWith(
      2,
      "/model-fallback.onnx",
      expect.objectContaining({ executionProviders: ["cpu"] })
    );
  });
});
