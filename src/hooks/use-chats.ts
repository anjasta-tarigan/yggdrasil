"use client";

import {
  createChatId,
  deleteChatsBulk,
  deriveTitle,
  loadChat,
  loadChatMetas,
  purgeLegacyChatStorage,
  saveChat,
  updateChatMeta,
  type StoredChat,
  type StoredChatMeta,
} from "@/lib/chat-storage";
import { hydrateSettings } from "@/lib/settings";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";

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

  // Ids whose deletion is pending (optimistic removal already applied
  // locally, server round-trip still in flight). The sync merge and the
  // settle-save path both consult this set so neither can resurrect a
  // chat the user just deleted. Ref, not state: it is read inside
  // synchronous guards where a state snapshot could be stale.
  const pendingDeletedRef = useRef<Set<string>>(new Set());

  // Pre-delete snapshot of the rows a bulk delete removed, held for the
  // failure-rollback path. Ref: written inside a setChats updater and
  // read inside a later async continuation — state would be stale there.
  const snapshotRef = useRef<StoredChat[] | null>(null);

  // Merge-lightweight metadata rows into local state: the incoming metas
  // carry no messages; preserve locally known messages unless the server
  // reports a newer updatedAt. Server absence stays authoritative for
  // deletions (missing rows are dropped, never resurrected).
  const mergeChatMetas = useCallback((metas: StoredChatMeta[]) => {
    setChats((prev) => {
      const byId = new Map(prev.map((c) => [c.id, c] as const));
      const pending = pendingDeletedRef.current;
      const merged = metas
        .filter((c) => !pending.has(c.id))
        .map((c): StoredChat => {
          const existing = byId.get(c.id);
          if (!existing) {
            return { id: c.id, title: c.title, updatedAt: c.updatedAt, messages: [], pinned: c.pinned };
          }
          if (existing.updatedAt >= c.updatedAt) {
            return {
              ...existing,
              title: c.title,
              pinned: c.pinned,
            };
          }
          return {
            ...existing,
            title: c.title,
            pinned: c.pinned,
            updatedAt: c.updatedAt,
            messages: [],
            messagesStale: true,
          };
        });
      merged.sort((a, b) => b.updatedAt - a.updatedAt);
      return merged;
    });
  }, []);

  // Boot: purge obsolete browser storage, hydrate the settings cache,
  // then load metadata followed by the active chat's full messages.
  // The metadata list re-syncs whenever the tab regains focus and every
  // 60s, so chats created or updated elsewhere (another tab, background
  // jobs) always appear — without parsing full _rawParts JSON for every
  // message across every chat on each poll.
  useEffect(() => {
    let cancelled = false;
    purgeLegacyChatStorage();
    const syncChats = async () => {
      try {
        const loaded = await loadChatMetas();
        if (cancelled) return;
        mergeChatMetas(loaded);
      } catch (error) {
        console.warn("Failed to load chats from database", error);
      }
    };
    void (async () => {
      await hydrateSettings();
      let loaded: StoredChatMeta[] = [];
      try {
        loaded = await loadChatMetas();
      } catch (error) {
        console.warn("Failed to load chats from database", error);
      }
      if (cancelled) return;
      setChats(
        loaded.map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updatedAt,
          messages: [],
          pinned: c.pinned,
        }))
      );
      const initialId = loaded[0]?.id ?? createChatId();
      setActiveChatId((current) => current ?? initialId);
      // Fetch the newest chat's full messages in the background so the
      // conversation view is not empty on first load.
      if (loaded.length > 0 && !cancelled) {
        try {
          const full = await loadChat(initialId);
          if (cancelled || !full) return;
          setChats((prev) =>
            prev.map((c) => (c.id === full.id ? { ...full, messagesStale: false } : c))
          );
        } catch (error) {
          console.warn("Failed to load active chat messages", error);
        }
      }
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
    // mergeChatMetas is a stable useCallback (refs + setState only), so
    // listing it here never re-runs the boot effect.
  }, [mergeChatMetas]);

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
      // Guard: a chat deleted (bulk or single) while its stream was
      // settling must not be re-saved — saveChat inserts when absent, so
      // this would resurrect a chat the user just deleted.
      if (pendingDeletedRef.current.has(chatId)) return;
      if (messages.length === 0) return;
      const chat: StoredChat = {
        id: chatId,
        title: deriveTitle(messages),
        updatedAt: Date.now(),
        messages,
        pinned: chats.find((c) => c.id === chatId)?.pinned,
        messagesStale: false,
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

  /**
   * Select a chat and load its full messages when missing. The background
   * sync returns metadata-only rows (messages: [], messagesStale: true);
   * full content loads on demand here. ChatArea is keyed by the active
   * chat id and useChat's `messages` is initial-only state, so the full
   * messages must be in state BEFORE the id flips — otherwise the remount
   * would bind an empty conversation forever. On failure the id still
   * flips (never trap the user in the old chat) but the view stays empty
   * until the next retry.
   */
  const selectChat = useCallback(
    (id: string) => {
      const chat = chats.find((c) => c.id === id);
      const needsLoad =
        !chat || chat.messagesStale === true || chat.messages.length === 0;

      if (!needsLoad) {
        setActiveChatId(id);
        return;
      }

      // A never-synced id (fresh browser session, chat created in another
      // tab): flip immediately — there is nothing locally to preview and
      // the row may not exist yet.
      if (!chat) {
        setActiveChatId(id);
        return;
      }

      // Reserve the slot so a 60s sync merge does not overwrite the load
      // with a metadata-only row mid-flight.
      setChats((prev) =>
        prev.map((c) => (c.id === id ? { ...c, messagesStale: false } : c))
      );
      void loadChat(id)
        .then((full) => {
          if (!full) return;
          setChats((prev) =>
            prev.map((c) =>
              c.id === full.id ? { ...full, messagesStale: false } : c
            )
          );
          setActiveChatId(id);
        })
        .catch((error) => {
          console.warn("Failed to load chat messages", error);
          setActiveChatId(id);
        });
    },
    [chats]
  );

  /**
   * Optimistic multi-delete with rollback. Race safety:
   *  - ids are registered in pendingDeletedRef BEFORE state updates, so
   *    any sync merge or settle-save that lands mid-flight sees them;
   *  - the DB write is a single transactional bulk request, so the
   *    client and server can never end up half-deleted;
   *  - on failure the rows are restored from a pre-delete snapshot AND
   *    the ids leave the pending set — but only after a fresh loadChatMetas,
   *    so a concurrent deletion made elsewhere between snapshot and
   *    rollback is not overwritten (last-write-wins against the server's
   *    actual state, not our stale local guess).
   */
  const deleteChatsBulkByIds = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    // Register pending deletions first: everything below can be raced by
    // a 60s sync tick, a focus sync, or an in-flight handleSettled, and
    // each consults this set.
    for (const id of ids) pendingDeletedRef.current.add(id);

    setChats((prev) => {
      // Snapshot for rollback, captured inside the functional update so
      // it reflects exactly the rows being removed (a closure-captured
      // `chats` could be older or newer than what we filter out).
      const removed = prev.filter((c) => idSet.has(c.id));
      if (removed.length === 0) {
        // Nothing to remove (already gone — deleted in another tab and
        // synced, or double-invoked). Undo the pending registration: the
        // server round-trip below would still be harmless, but keeping
        // stale ids in the set would suppress legitimate future loads.
        for (const id of ids) pendingDeletedRef.current.delete(id);
        return prev;
      }
      const remaining = prev.filter((c) => !idSet.has(c.id));
      // Co-located active-chat fallback: reads post-delete state. If the
      // active chat was deleted, fall back to the newest remaining —
      // matching deleteChatById's contract, and to a brand-new chat id
      // when the whole history is gone.
      setActiveChatId((current) => {
        if (current === null) return null;
        if (!idSet.has(current)) return current;
        // Load the fallback chat's full messages before flipping the id:
        // ChatArea remounts on the id and useChat's messages prop is
        // initial-only — an unloaded (metadata-only) row would render an
        // empty conversation forever.
        const fallbackId = remaining[0]?.id;
        if (fallbackId) {
          const fallback = remaining[0];
          if (fallback.messagesStale || fallback.messages.length === 0) {
            void loadChat(fallbackId)
              .then((full) => {
                if (!full) return;
                setChats((later) =>
                  later.map((c) =>
                    c.id === full.id ? { ...full, messagesStale: false } : c
                  )
                );
              })
              .catch((error) =>
                console.warn("Failed to load fallback chat messages", error)
              );
          }
        }
        return fallbackId ?? createChatId();
      });
      snapshotRef.current = removed;
      return remaining;
    });

    void (async () => {
      try {
        await deleteChatsBulk(ids);
      } catch (error) {
        console.warn("Failed to bulk-delete chats from database", error);
        // Rollback — but reconcile with the server first (a fresh load
        // prevents restoring rows another tab deleted in the window
        // between our optimistic update and this failure).
        try {
          const fresh = await loadChatMetas();
          const freshIds = new Set(fresh.map((c) => c.id));
          setChats((prev) => {
            const snapshot = snapshotRef.current ?? [];
            snapshotRef.current = null;
            const restore = snapshot.filter((c) => freshIds.has(c.id));
            const restoredIds = new Set(restore.map((c) => c.id));
            const merged = [
              ...restore,
              ...prev.filter((c) => !restoredIds.has(c.id)),
            ];
            merged.sort((a, b) => b.updatedAt - a.updatedAt);
            return merged;
          });
        } catch (loadError) {
          console.warn("Failed to reload chats after delete failure", loadError);
          // Last resort: restore the snapshot unconditionally. A rare
          // wrong-side resurrection here self-heals on the next sync
          // (server absence is authoritative).
          setChats((prev) => {
            const snapshot = snapshotRef.current ?? [];
            snapshotRef.current = null;
            const snapIds = new Set(snapshot.map((c) => c.id));
            return [...snapshot, ...prev.filter((c) => !snapIds.has(c.id))];
          });
        }
      } finally {
        for (const id of ids) pendingDeletedRef.current.delete(id);
      }
    })();
  }, []);

  // Single-delete delegates to the bulk path so both share the same
  // pending-registration, snapshot-rollback, and active-chat fallback
  // guarantees (one code path, no drift between behaviors).
  const deleteChatById = useCallback(
    (id: string) => {
      deleteChatsBulkByIds([id]);
    },
    [deleteChatsBulkByIds]
  );

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

  return {
    chats,
    activeChat,
    activeChatId,
    setActiveChatId,
    settleChat,
    newChat,
    deleteChatById,
    deleteChatsBulkByIds,
    renameChat,
    togglePinChat,
    selectChat,
  };
}
