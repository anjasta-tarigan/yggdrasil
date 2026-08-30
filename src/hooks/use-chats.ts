"use client";

import {
  createChatId,
  deleteChat,
  deriveTitle,
  loadChats,
  purgeLegacyChatStorage,
  saveChat,
  updateChatMeta,
  type StoredChat,
} from "@/lib/chat-storage";
import { hydrateSettings } from "@/lib/settings";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useState } from "react";

/**
 * Owns the chat list: hydration from the server database, background
 * re-sync (tab focus + 60s interval), and the local mutations that
 * mirror their effects into the database (settle-save, delete, rename,
 * pin). The active chat id is co-located so delete/rename can keep it
 * consistent without closure-capture races.
 */
export function useChats() {
  const [chats, setChats] = useState<StoredChat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  // Boot: purge obsolete browser storage, hydrate the settings cache,
  // then load the chat list from the database. The list also re-syncs
  // whenever the tab regains focus and every 60s, so chats created or
  // updated elsewhere (another tab, background jobs) always appear.
  useEffect(() => {
    let cancelled = false;
    purgeLegacyChatStorage();
    const syncChats = async () => {
      try {
        const loaded = await loadChats();
        if (cancelled) return;
        // Merge fresh rows without disturbing an in-progress active chat
        // (its live messages stream in via ChatArea handlers). Functional
        // update only — never compute from a closure-captured list, or an
        // in-flight handleSettled would clobber the merge.
        setChats((prev) => {
          const byId = new Map(prev.map((c) => [c.id, c] as const));
          const merged = loaded.map((c) => {
            const existing = byId.get(c.id);
            if (!existing) return c;
            // Keep the local copy when its message set is newer (live
            // streaming settles here)…
            if (existing.updatedAt >= c.updatedAt) {
              // …but meta edits made elsewhere (rename/pin do not bump
              // updatedAt) must still propagate — trust the server row
              // for title/pinned unless the local copy is strictly newer.
              return {
                ...existing,
                title: c.title,
                pinned: c.pinned,
              };
            }
            return c;
          });
          // Server absence is authoritative for deletions: rows missing
          // from the fresh load were deleted elsewhere and must not be
          // resurrected here (re-appending would undo the deletion in the
          // DB via saveChat's insert-when-absent path).
          merged.sort((a, b) => b.updatedAt - a.updatedAt);
          return merged;
        });
      } catch (error) {
        console.warn("Failed to load chats from database", error);
      }
    };
    void (async () => {
      await hydrateSettings();
      let loaded: StoredChat[] = [];
      try {
        loaded = await loadChats();
      } catch (error) {
        console.warn("Failed to load chats from database", error);
      }
      if (cancelled) return;
      setChats(loaded);
      setActiveChatId(loaded[0]?.id ?? createChatId());
    })();
    const onFocus = () => {
      if (typeof document !== "undefined" && !document.hidden) void syncChats();
    };
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) void syncChats();
    }, 60_000);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onFocus);
      window.addEventListener("focus", onFocus);
    }
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onFocus);
        window.removeEventListener("focus", onFocus);
      }
    };
  }, []);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;

  /**
   * Persist a settled conversation: bumps the chat to the head of the
   * list and saves it to the database. Reads `pinned` synchronously from
   * the current list so the save payload carries it (a functional update
   * would run after saveChat already serialized pinned:undefined —
   * silently unpinning every settled chat in the DB).
   */
  const settleChat = useCallback(
    (chatId: string, messages: UIMessage[]) => {
      if (messages.length === 0) return;
      const chat: StoredChat = {
        id: chatId,
        title: deriveTitle(messages),
        updatedAt: Date.now(),
        messages,
        pinned: chats.find((c) => c.id === chatId)?.pinned,
      };
      // Functional update: computes from live state so a concurrent sync
      // merge (60s interval / focus handler) is never clobbered.
      setChats((prev) => [chat, ...prev.filter((c) => c.id !== chatId)]);
      void saveChat(chat).catch((error) =>
        console.warn("Failed to save chat to database", error)
      );
    },
    [chats]
  );

  const newChat = useCallback(() => {
    setActiveChatId(createChatId());
  }, []);

  const deleteChatById = useCallback((id: string) => {
    // Functional updates throughout: the active-chat fallback reads the
    // post-delete state, not a closure-captured snapshot.
    setChats((prev) => {
      const remaining = prev.filter((c) => c.id !== id);
      setActiveChatId((current) =>
        current === id ? (remaining[0]?.id ?? createChatId()) : current
      );
      return remaining;
    });
    void deleteChat(id).catch((error) =>
      console.warn("Failed to delete chat from database", error)
    );
  }, []);

  const renameChat = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setChats((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, title: trimmed.slice(0, 120) } : c
      )
    );
    void updateChatMeta(id, { title: trimmed }).catch((error) =>
      console.warn("Failed to rename chat in database", error)
    );
  }, []);

  const togglePinChat = useCallback((id: string) => {
    setChats((prev) => {
      const chat = prev.find((c) => c.id === id);
      if (!chat) return prev;
      const pinned = !chat.pinned;
      void updateChatMeta(id, { pinned }).catch((error) =>
        console.warn("Failed to update pin in database", error)
      );
      return prev.map((c) =>
        c.id === id ? { ...c, pinned: pinned || undefined } : c
      );
    });
  }, []);

  const selectChat = useCallback((id: string) => {
    setActiveChatId(id);
  }, []);

  return {
    chats,
    activeChat,
    activeChatId,
    setActiveChatId,
    settleChat,
    newChat,
    deleteChatById,
    renameChat,
    togglePinChat,
    selectChat,
  };
}
