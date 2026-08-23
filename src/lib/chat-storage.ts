import type { UIMessage } from "ai";

/**
 * localStorage-backed multi-chat store.
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
    .map((p) => p.text)
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
}

export function deleteChat(id: string): void {
  const store = readStore();
  store.chats = store.chats.filter((c) => c.id !== id);
  writeStore(store);
}
