import type { UIMessage } from "ai";

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

/** All chats, most recently updated first. */
export async function loadChats(): Promise<StoredChat[]> {
  const res = await fetch("/api/chats", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load chats (HTTP ${res.status})`);
  const data = (await res.json()) as { chats?: StoredChat[] };
  return Array.isArray(data.chats) ? data.chats : [];
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
