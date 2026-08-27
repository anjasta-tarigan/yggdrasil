import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createChatId,
  deriveTitle,
  loadChats,
  loadChat,
  saveChat,
  deleteChat,
  updateChatMeta,
  purgeLegacyChatStorage,
  type StoredChat,
} from "../chat-storage";
import type { UIMessage } from "ai";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("Client Chat Storage (database-backed)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("creates unique chat IDs with chat- prefix", () => {
    const id1 = createChatId();
    const id2 = createChatId();
    expect(id1).toMatch(/^chat-[a-z0-9]+-[a-z0-9]+$/);
    expect(id2).toMatch(/^chat-[a-z0-9]+-[a-z0-9]+$/);
    expect(id1).not.toBe(id2);
  });

  it("derives title from first user text part", () => {
    const messages: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "How do I build a Next.js app with SQLite?" }],
      },
      {
        id: "2",
        role: "assistant",
        parts: [{ type: "text", text: "Here is how to set up SQLite..." }],
      },
    ];

    expect(deriveTitle(messages)).toBe("How do I build a Next.js app with SQLite?");
  });

  it("truncates long titles to 48 characters with ellipsis", () => {
    const messages: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [
          {
            type: "text",
            text: "This is a very long prompt that goes beyond forty eight characters for testing title truncation",
          },
        ],
      },
    ];

    const title = deriveTitle(messages);
    expect(title.length).toBe(49); // 48 + 1 char ellipsis (unicode "…")
    expect(title.endsWith("…")).toBe(true);
  });

  it("purges obsolete localStorage chat keys", () => {
    window.localStorage.setItem("yggdrasil:chats:v2", "{}");
    window.localStorage.setItem("yggdrasil:chat:v1", "[]");

    purgeLegacyChatStorage();

    expect(window.localStorage.getItem("yggdrasil:chats:v2")).toBeNull();
    expect(window.localStorage.getItem("yggdrasil:chat:v1")).toBeNull();
  });

  it("loads chats from GET /api/chats", async () => {
    const chats: StoredChat[] = [
      { id: "c2", title: "Newer", updatedAt: 2000, messages: [] },
      { id: "c1", title: "Older", updatedAt: 1000, messages: [] },
    ];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ chats }));
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadChats();
    expect(loaded).toEqual(chats);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats", { cache: "no-store" });
  });

  it("returns an empty list when the server response has no chats field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
    expect(await loadChats()).toEqual([]);
  });

  it("throws when the chat list request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500))
    );
    await expect(loadChats()).rejects.toThrow("HTTP 500");
  });

  it("loads a single chat and maps 404 to undefined", async () => {
    const chat: StoredChat = { id: "c1", title: "T", updatedAt: 1, messages: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ chat }))
      .mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadChat("c1")).toEqual(chat);
    expect(await loadChat("missing")).toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/chats/c1", {
      cache: "no-store",
    });
  });

  it("saves chats via POST /api/chats", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const chat: StoredChat = {
      id: "c-sync",
      title: "Sync Chat",
      updatedAt: 3000,
      messages: [],
    };
    await saveChat(chat);

    expect(fetchMock).toHaveBeenCalledWith("/api/chats", {
      body: JSON.stringify(chat),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  });

  it("rejects saveChat when the server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500))
    );
    const chat: StoredChat = { id: "c", title: "t", updatedAt: 1, messages: [] };
    await expect(saveChat(chat)).rejects.toThrow("HTTP 500");
  });

  it("deletes chats via DELETE /api/chats/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteChat("c-sync");
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/c-sync", {
      method: "DELETE",
    });
  });

  it("updates chat metadata via PATCH /api/chats/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    await updateChatMeta("c1", { pinned: true, title: "Renamed" });
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/c1", {
      body: JSON.stringify({ pinned: true, title: "Renamed" }),
      headers: { "Content-Type": "application/json" },
      method: "PATCH",
    });
  });

  it("never writes chat data to localStorage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal("fetch", fetchMock);

    const chat: StoredChat = { id: "c9", title: "T", updatedAt: 1, messages: [] };
    await saveChat(chat);
    await updateChatMeta("c9", { pinned: true });
    await deleteChat("c9");

    expect(window.localStorage.length).toBe(0);
  });
});
