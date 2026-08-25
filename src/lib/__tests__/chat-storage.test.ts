import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  createChatId,
  deriveTitle,
  loadChats,
  loadChat,
  saveChat,
  deleteChat,
  type StoredChat,
} from "../chat-storage";
import type { UIMessage } from "ai";

describe("Client Chat Storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
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

  it("saves and loads chats with sorting by updatedAt descending", () => {
    const chat1: StoredChat = {
      id: "c1",
      title: "Older Chat",
      updatedAt: 1000,
      messages: [],
    };
    const chat2: StoredChat = {
      id: "c2",
      title: "Newer Chat",
      updatedAt: 2000,
      messages: [],
    };

    saveChat(chat1);
    saveChat(chat2);

    const chats = loadChats();
    expect(chats.length).toBe(2);
    expect(chats[0].id).toBe("c2");
    expect(chats[1].id).toBe("c1");

    const single = loadChat("c1");
    expect(single).toBeDefined();
    expect(single?.title).toBe("Older Chat");
  });

  it("triggers background sync with /api/chats on save and delete", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    global.fetch = fetchMock;

    const chat: StoredChat = {
      id: "c-sync",
      title: "Sync Chat",
      updatedAt: 3000,
      messages: [],
    };

    saveChat(chat);
    expect(fetchMock).toHaveBeenCalledWith("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chat),
    });

    deleteChat("c-sync");
    expect(fetchMock).toHaveBeenCalledWith("/api/chats/c-sync", {
      method: "DELETE",
    });
    expect(loadChat("c-sync")).toBeUndefined();
  });
});
