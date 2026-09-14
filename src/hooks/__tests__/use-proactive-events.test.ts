import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useProactiveEvents } from "../use-proactive-events";

describe("useProactiveEvents", () => {
  const originalFetch = globalThis.fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads unread events on mount", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        events: [
          { id: "evt-1", kind: "reminder", title: "Test Event", body: null, chatId: null, createdAt: Date.now() },
        ],
      }),
    });

    const { result } = renderHook(() => useProactiveEvents());

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
      expect(result.current.unreadCount).toBe(1);
      expect(result.current.events[0].id).toBe("evt-1");
    });
  });

  it("handles fetch failure gracefully without throwing", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const { result } = renderHook(() => useProactiveEvents());

    // Should stay empty array, no unhandled rejection
    expect(result.current.events).toEqual([]);
    expect(result.current.unreadCount).toBe(0);
  });

  it("optimistically marks one event as read", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          events: [
            { id: "evt-1", kind: "reminder", title: "Test 1", body: null, chatId: null, createdAt: Date.now() },
            { id: "evt-2", kind: "reminder", title: "Test 2", body: null, chatId: null, createdAt: Date.now() },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
      });

    const { result } = renderHook(() => useProactiveEvents());

    await waitFor(() => {
      expect(result.current.events).toHaveLength(2);
    });

    await act(async () => {
      await result.current.markRead("evt-1");
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].id).toBe("evt-2");
    expect(mockFetch).toHaveBeenCalledWith("/api/events/evt-1/read", { method: "POST" });
  });

  it("optimistically marks all events as read", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          events: [
            { id: "evt-1", kind: "reminder", title: "Test 1", body: null, chatId: null, createdAt: Date.now() },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
      });

    const { result } = renderHook(() => useProactiveEvents());

    await waitFor(() => {
      expect(result.current.events).toHaveLength(1);
    });

    await act(async () => {
      await result.current.markAllRead();
    });

    expect(result.current.events).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledWith("/api/events", { method: "POST" });
  });
});
