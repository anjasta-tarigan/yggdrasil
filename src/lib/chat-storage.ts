import type { UIMessage } from "ai";

/**
 * localStorage-backed multi-chat store with SQLite backend synchronization.
 *
 * Shape: { chats: [{ id, title, updatedAt, messages }] }
 * Also migrates the legacy single-chat key (yggdrasil:chat:v1) on first read.
 */

const STORAGE_KEY = "yggdrasil:chats:v2";
const LEGACY_KEY = "yggdrasil:chat:v1";

export type StoredChat = {
  id: string;
  title: string;
  updatedAt: number;
  messages: UIMessage[];
  /** Pinned chats float to their own section at the top of the history. */
  pinned?: boolean;
};

type StoreShape = { chats: StoredChat[] };

function isUIMessage(value: unknown): value is UIMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as UIMessage;
  return (
    typeof m.id === "string" &&
    typeof m.role === "string" &&
    Array.isArray(m.parts)
  );
}

function sanitizeMessages(value: unknown): UIMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isUIMessage);
}

function readStore(): StoreShape {
  if (typeof window === "undefined") return { chats: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as StoreShape).chats)
      ) {
        const chats = (parsed as StoreShape).chats
          .filter(
            (c): c is StoredChat =>
              typeof c === "object" &&
              c !== null &&
              typeof c.id === "string" &&
              Array.isArray(c.messages)
          )
          .map((c) => ({
            id: c.id,
            title: typeof c.title === "string" ? c.title : "Untitled chat",
            updatedAt: typeof c.updatedAt === "number" ? c.updatedAt : 0,
            messages: sanitizeMessages(c.messages),
            pinned:
              typeof c.pinned === "boolean" && c.pinned ? true : undefined,
          }));
        return { chats };
      }
    }

    // One-time migration from the legacy single-chat key.
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const messages = sanitizeMessages(JSON.parse(legacy));
      if (messages.length > 0) {
        const migrated: StoreShape = {
          chats: [
            {
              id: createChatId(),
              title: deriveTitle(messages),
              updatedAt: Date.now(),
              messages,
            },
          ],
        };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        window.localStorage.removeItem(LEGACY_KEY);
        return migrated;
      }
    }
  } catch (error) {
    console.warn("Failed to read chat store", error);
  }
  return { chats: [] };
}

function writeStore(store: StoreShape) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    console.warn("Failed to write chat store", error);
  }
}

export function createChatId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function deriveTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser?.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join(" ")
    .trim();
  if (!text) return "New chat";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export function loadChats(): StoredChat[] {
  return readStore().chats.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadChat(id: string): StoredChat | undefined {
  return readStore().chats.find((c) => c.id === id);
}

export function saveChat(chat: StoredChat): void {
  const store = readStore();
  const index = store.chats.findIndex((c) => c.id === chat.id);
  if (index >= 0) {
    store.chats[index] = chat;
  } else {
    store.chats.push(chat);
  }
  writeStore(store);

  // Background sync with SQLite database
  if (typeof window !== "undefined") {
    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chat),
    }).catch((e) => console.warn("Failed to sync chat to SQLite backend:", e));
  }
}

export function deleteChat(id: string): void {
  const store = readStore();
  store.chats = store.chats.filter((c) => c.id !== id);
  writeStore(store);

  if (typeof window !== "undefined") {
    fetch(`/api/chats/${id}`, {
      method: "DELETE",
    }).catch((e) => console.warn("Failed to delete chat on backend:", e));
  }
}

/**
 * Update chat metadata (title, pinned) without touching messages or
 * updatedAt. Persists locally and re-syncs the full chat to the backend.
 */
export function updateChatMeta(
  id: string,
  patch: { title?: string; pinned?: boolean }
): void {
  const store = readStore();
  const chat = store.chats.find((c) => c.id === id);
  if (!chat) return;

  if (typeof patch.title === "string") {
    const title = patch.title.trim();
    if (title) chat.title = title.slice(0, 120);
  }
  chat.pinned = patch.pinned ? true : undefined;

  writeStore(store);

  if (typeof window !== "undefined") {
    fetch("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chat),
    }).catch((e) => console.warn("Failed to sync chat meta to backend:", e));
  }
}
