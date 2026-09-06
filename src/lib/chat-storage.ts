import type { UIMessage } from "ai";
import type { MessageFeedback } from "@/components/chat/chat-utils";

/**
 * Chat store client — SQLite is the single source of truth.
 *
 * All chat data lives in the server database (chat_sessions /
 * chat_messages) and is accessed through the /api/chats endpoints.
 * Nothing chat-related is persisted in the browser anymore; the old
 * localStorage keys are purged once on boot.
 */

export type StoredChat = {
  id: string;
  title: string;
  updatedAt: number;
  messages: UIMessage[];
  /** Pinned chats float to their own section at the top of the history. */
  pinned?: boolean;
  /** True when the local messages array is empty and needs a background refresh via loadChat. */
  messagesStale?: boolean;
};

/** Lightweight list item: session metadata without message bodies. */
export type StoredChatMeta = {
  id: string;
  title: string;
  updatedAt: number;
  /** Pinned chats float to their own section at the top of the history. */
  pinned?: boolean;
};

/** Legacy browser keys that no longer hold any data. */
const LEGACY_STORAGE_KEYS = ["yggdrasil:chats:v2", "yggdrasil:chat:v1"];

/**
 * Remove the obsolete localStorage chat keys (one-time cleanup after the
 * move to database-backed persistence).
 */
export function purgeLegacyChatStorage(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of LEGACY_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    /* non-fatal */
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

/** All chats with their messages, most recently updated first. */
export async function loadChats(): Promise<StoredChat[]> {
  const res = await fetch("/api/chats", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load chats (HTTP ${res.status})`);
  const data = (await res.json()) as { chats?: StoredChat[] };
  return Array.isArray(data.chats) ? data.chats : [];
}

/**
 * Lightweight chat listing alias (compatible with metadata-only usage).
 */
export async function loadChatMetas(): Promise<StoredChatMeta[]> {
  return loadChats();
}

/** One chat by id, or undefined when it does not exist. */
export async function loadChat(id: string): Promise<StoredChat | undefined> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Failed to load chat (HTTP ${res.status})`);
  const data = (await res.json()) as { chat?: StoredChat };
  return data.chat;
}

/** Insert or fully replace a chat (session row + all messages). */
export async function saveChat(chat: StoredChat): Promise<void> {
  const res = await fetch("/api/chats", {
    body: JSON.stringify(chat),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to save chat (HTTP ${res.status})`);
}

/** Delete a chat and all of its messages. */
export async function deleteChat(id: string): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete chat (HTTP ${res.status})`);
}

/**
 * Bulk-delete chats by id in one request. Returns the server-reported
 * deletion count (ids already gone elsewhere count as 0, not an error).
 */
export async function deleteChatsBulk(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await fetch("/api/chats/bulk-delete", {
    body: JSON.stringify({ ids }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Failed to bulk-delete chats (HTTP ${res.status})`);
  }
  const data = (await res.json().catch(() => null)) as {
    deleted?: number;
  } | null;
  return typeof data?.deleted === "number" ? data.deleted : ids.length;
}

/** Update chat metadata (title, pinned) without touching messages. */
export async function updateChatMeta(
  id: string,
  patch: { title?: string; pinned?: boolean }
): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
    body: JSON.stringify(patch),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!res.ok) throw new Error(`Failed to update chat (HTTP ${res.status})`);
}

/**
 * Persist a single message's thumbs-up/down vote to the server.
 *
 * Used for messages that are already settled in the database (historical
 * messages in a past turn). Messages in the current active turn carry
 * their feedback through the normal chat settle-save path automatically
 * — the metadata is serialised into chat_messages.metadata by saveChatDb.
 *
 * Throws when the network request fails so callers can log and optionally
 * surface the error (never suppress silently).
 */
export async function setMessageFeedback(
  chatId: string,
  messageId: string,
  feedback: MessageFeedback | null
): Promise<void> {
  const res = await fetch(
    `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/feedback`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    }
  );
  if (!res.ok) {
    throw new Error(`Failed to save feedback (HTTP ${res.status})`);
  }
}
