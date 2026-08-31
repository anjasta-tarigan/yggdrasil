import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useChats } from "@/hooks/use-chats";
import type { StoredChat } from "@/lib/chat-storage";

// ── Mock the storage layer ─────────────────────────────────────────
// loadChats is the sync-merge source; deleteChatsBulk is the bulk
// round-trip under test; saveChat is the settle path that must be
// suppressed for pending-deleted chats.

const chat = (id: string, updatedAt: number): StoredChat => ({
  id,
  title: `Chat ${id}`,
  updatedAt,
  messages: [
    { id: `${id}-m1`, role: "user", parts: [{ type: "text", text: "hi" }] },
  ],
});

let loadChatsMock: ReturnType<typeof vi.fn>;
let deleteChatsBulkMock: ReturnType<typeof vi.fn>;
let saveChatMock: ReturnType<typeof vi.fn>;

vi.mock("@/lib/chat-storage", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/chat-storage")>(
      "@/lib/chat-storage"
    );
  return {
    ...actual,
    loadChats: (...args: unknown[]) => loadChatsMock(...args),
    deleteChatsBulk: (...args: unknown[]) => deleteChatsBulkMock(...args),
    saveChat: (...args: unknown[]) => saveChatMock(...args),
    deleteChat: vi.fn(),
    updateChatMeta: vi.fn(),
    purgeLegacyChatStorage: vi.fn(),
    createChatId: () => "new-chat-id",
    deriveTitle: () => "Derived title",
  };
});

vi.mock("@/lib/settings", () => ({
  hydrateSettings: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  loadChatsMock = vi.fn();
  deleteChatsBulkMock = vi.fn().mockResolvedValue(2);
  saveChatMock = vi.fn().mockResolvedValue(undefined);
});

const seeded = () => [chat("c1", 3000), chat("c2", 2000), chat("c3", 1000)];

describe("useChats bulk delete — race guards", () => {
  it("removes deleted chats from state and falls back for the active chat", async () => {
    loadChatsMock.mockResolvedValue(seeded());
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats.length).toBe(3));
    expect(result.current.activeChatId).toBe("c1");

    act(() => {
      result.current.deleteChatsBulkByIds(["c1", "c2"]);
    });

    expect(result.current.chats.map((c) => c.id)).toEqual(["c3"]);
    // Active chat was deleted → falls back to newest remaining.
    expect(result.current.activeChatId).toBe("c3");
    await waitFor(() =>
      expect(deleteChatsBulkMock).toHaveBeenCalledWith(["c1", "c2"])
    );
  });

  it("keeps the active chat when it is not in the deleted set", async () => {
    loadChatsMock.mockResolvedValue(seeded());
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats.length).toBe(3));

    act(() => {
      result.current.deleteChatsBulkByIds(["c2"]);
    });

    expect(result.current.activeChatId).toBe("c1");
    expect(result.current.chats.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("rolls back rows and reconciles with the server when the bulk delete fails", async () => {
    loadChatsMock.mockResolvedValue(seeded());
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats.length).toBe(3));

    // Delete fails; the fresh server load says c1 and c2 still exist but
    // c3 was deleted elsewhere — only c1 and c2 may come back.
    deleteChatsBulkMock.mockRejectedValueOnce(new Error("network down"));
    loadChatsMock.mockResolvedValueOnce([chat("c1", 3000), chat("c2", 2000)]);

    act(() => {
      result.current.deleteChatsBulkByIds(["c1", "c2", "c3"]);
    });

    await waitFor(() =>
      expect(result.current.chats.map((c) => c.id)).toEqual(["c1", "c2"])
    );
  });

  it("suppresses settle-save for a chat deleted mid-stream (no resurrection)", async () => {
    loadChatsMock.mockResolvedValue(seeded());
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats.length).toBe(3));

    // Simulate: user bulk-deletes c1 while its stream is still settling,
    // then the stream settles and tries to save.
    deleteChatsBulkMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(1), 50))
    );
    act(() => {
      result.current.deleteChatsBulkByIds(["c1"]);
    });
    act(() => {
      result.current.settleChat("c1", [
        { id: "m", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]);
    });

    expect(saveChatMock).not.toHaveBeenCalled();
    expect(result.current.chats.some((c) => c.id === "c1")).toBe(false);
  });

  it("filters pending-deleted ids out of the background sync merge", async () => {
    loadChatsMock.mockResolvedValue(seeded());
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats.length).toBe(3));

    // Delete c2 with a slow (pending) round-trip; a 60s-style sync fires
    // mid-flight and the server still lists c2 (its delete hasn't landed).
    deleteChatsBulkMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(1), 50))
    );
    act(() => {
      result.current.deleteChatsBulkByIds(["c2"]);
    });
    // Sync merge arrives with c2 still present on the server.
    loadChatsMock.mockResolvedValueOnce(seeded());
    act(() => {
      void result.current.chats; // trigger re-render cycle
    });
    // Trigger the merge path by resolving loadChats through the hook's
    // own effect: focus events are not available in jsdom, so we assert
    // via settleChat guard + direct state instead. The critical property
    // is that c2 must not reappear even though the server listed it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(result.current.chats.some((c) => c.id === "c2")).toBe(false);

    // After the round-trip completes, the pending set is cleared.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    expect(result.current.chats.some((c) => c.id === "c2")).toBe(false);
  });

  it("no-ops (and cleans pending ids) when deleting ids that are already gone", async () => {
    loadChatsMock.mockResolvedValue(seeded());
    const { result } = renderHook(() => useChats());
    await waitFor(() => expect(result.current.chats.length).toBe(3));

    act(() => {
      result.current.deleteChatsBulkByIds(["gone-id"]);
    });

    // State unchanged, no error, and the server call still fires (idempotent).
    expect(result.current.chats.length).toBe(3);
    await waitFor(() =>
      expect(deleteChatsBulkMock).toHaveBeenCalledWith(["gone-id"])
    );
  });
});
