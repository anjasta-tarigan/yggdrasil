import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useDatabaseMaintenance } from "../hooks/use-database-maintenance";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("useDatabaseMaintenance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("queues a cognitive maintenance pass and refreshes after delay", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true }));
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useDatabaseMaintenance({ onRefresh }));

    await act(async () => {
      await result.current.runMaintenancePass("light_sleep");
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pass: "light_sleep" }),
    });
    expect(result.current.maintenanceNote).toContain("queued");
    expect(result.current.maintenanceBusy).toBeNull();
    expect(onRefresh).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("runs embedding backfill and refreshes immediately", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ embeddedCount: 42, remaining: 0 }));
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useDatabaseMaintenance({ onRefresh }));

    await act(async () => {
      await result.current.runEmbeddingBackfillNow();
    });

    // The CSRF guard rejects bodyless POSTs without a JSON content type.
    expect(fetchMock).toHaveBeenCalledWith("/api/maintenance/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(result.current.maintenanceNote).toContain("Backfill embedded 42 memories; 0 still pending.");
    expect(result.current.maintenanceBusy).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("handles storage optimization with vacuum", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ok: true, message: "Storage optimized" })
    );
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useDatabaseMaintenance({ onRefresh }));

    await act(async () => {
      await result.current.optimizeDatabase(true);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/maintenance/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vacuum: true }),
    });
    expect(result.current.dbNote).toBe("Storage optimized");
    expect(result.current.dbNoteKind).toBe("storage");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("handles storage optimization without vacuum and skips refresh", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ok: true, message: "Planner optimized" })
    );
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useDatabaseMaintenance({ onRefresh }));

    await act(async () => {
      await result.current.optimizeDatabase(false);
    });

    expect(result.current.dbNote).toBe("Planner optimized");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("resets database, clears diagnostics, and refreshes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true, message: "Database reset complete." }));
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useDatabaseMaintenance({ onRefresh }));

    await act(async () => {
      await result.current.resetDatabaseNow();
    });

    // The CSRF guard rejects bodyless POSTs without a JSON content type.
    expect(fetchMock).toHaveBeenCalledWith("/api/maintenance/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(result.current.dbNote).toBe("Database reset complete.");
    expect(result.current.dbNoteKind).toBe("reset");
    expect(result.current.diagnostics).toBeNull();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("fetches and sets database diagnostics", async () => {
    const diagData = {
      ok: true,
      metrics: { dbSizeBytes: 1024, walSizeBytes: 256 },
      slowOperations: [],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(diagData));
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useDatabaseMaintenance({ onRefresh }));

    await act(async () => {
      await result.current.refreshDiagnostics();
    });

    expect(result.current.diagnostics).toEqual({
      metrics: diagData.metrics,
      slowOperations: [],
    });
    expect(result.current.diagnosticsBusy).toBe(false);
  });

  it("allows setting maintenanceNote directly", () => {
    const onRefresh = vi.fn();
    const { result } = renderHook(() => useDatabaseMaintenance({ onRefresh }));

    act(() => {
      result.current.setMaintenanceNote("Rebuild completed");
    });

    expect(result.current.maintenanceNote).toBe("Rebuild completed");
  });
});
