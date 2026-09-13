import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST as POSTRebuild } from "../maintenance/rebuild-index/route";
import { POST as POSTDismiss } from "../maintenance/dismiss-model-change/route";

const setSettingsDbMock = vi.fn();

vi.mock("@/lib/settings-service", () => ({
  setSettingsDb: (...args: unknown[]) => setSettingsDbMock(...args),
}));

vi.mock("@/lib/memory/embed-backfill", () => ({
  rebuildEmbeddingIndex: vi.fn(),
}));

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
}));

describe("Maintenance API routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /api/maintenance/rebuild-index", () => {
    it("returns success with counts on a successful rebuild", async () => {
      const { rebuildEmbeddingIndex } = await import("@/lib/memory/embed-backfill");
      vi.mocked(rebuildEmbeddingIndex).mockResolvedValueOnce({
        nulledCount: 100,
        embeddedCount: 95,
        remaining: 5,
      });

      const res = await POSTRebuild();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.nulledCount).toBe(100);
      expect(data.embeddedCount).toBe(95);
      expect(data.remaining).toBe(5);

      // The model-change flag must be cleared on success.
      expect(setSettingsDbMock).toHaveBeenCalledWith({
        embedding_model_changed: undefined,
      });
    });

    it("returns 500 when rebuildEmbeddingIndex throws", async () => {
      const { rebuildEmbeddingIndex } = await import("@/lib/memory/embed-backfill");
      vi.mocked(rebuildEmbeddingIndex).mockRejectedValueOnce(
        new Error("endpoint unreachable")
      );

      const res = await POSTRebuild();
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Embedding index rebuild failed");

      // On failure the flag is NOT cleared.
      expect(setSettingsDbMock).not.toHaveBeenCalled();
    });

    it("passes the default db to rebuildEmbeddingIndex", async () => {
      const { rebuildEmbeddingIndex } = await import("@/lib/memory/embed-backfill");
      vi.mocked(rebuildEmbeddingIndex).mockResolvedValueOnce({
        nulledCount: 0,
        embeddedCount: 0,
        remaining: 0,
      });

      await POSTRebuild();

      // Called with no explicit options (uses default db).
      expect(rebuildEmbeddingIndex).toHaveBeenCalledWith();
    });
  });

  describe("POST /api/maintenance/dismiss-model-change", () => {
    it("clears the model-change flag and returns success", async () => {
      const res = await POSTDismiss();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      expect(setSettingsDbMock).toHaveBeenCalledWith({
        embedding_model_changed: undefined,
      });
    });
  });
});
