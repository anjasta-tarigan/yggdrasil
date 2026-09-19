import { eq, desc, inArray, notInArray, and, sql } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { chatSessions, chatMessages } from "@/db/schema";
import type { StoredChat } from "./chat-storage";
import type { UIMessage } from "ai";

export async function countChatsDb(db: AppDatabase = defaultDb): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)` })
    .from(chatSessions);
  return Number(result?.count ?? 0);
}

export async function listChatsDb(db: AppDatabase = defaultDb): Promise<StoredChat[]> {
  const sessions = await db
    .select()
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt));

  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id);
  const allMessages = await db
    .select()
    .from(chatMessages)
    .where(inArray(chatMessages.sessionId, sessionIds))
    .orderBy(chatMessages.createdAt);

  const messagesBySession = new Map<string, UIMessage[]>();
  for (const r of allMessages) {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const parts = Array.isArray(meta._rawParts)
      ? (meta._rawParts as UIMessage["parts"])
      : [
          {
            type: "text" as const,
            text: r.content,
          },
        ];

    const msg: UIMessage = {
      id: r.id,
      role: r.role as "user" | "assistant" | "system",
      parts,
      metadata: (meta.usage || meta.data ? meta : undefined) as UIMessage["metadata"],
    };

    const list = messagesBySession.get(r.sessionId) ?? [];
    list.push(msg);
    messagesBySession.set(r.sessionId, list);
  }

  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    pinned: Boolean(session.pinned),
    updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
    messages: messagesBySession.get(session.id) ?? [],
  }));
}

/**
 * Lightweight list of chat metadata (sessions only, no messages).
 * Used by the background sync (60s / focus) so tab switches and polls
 * do not parse full _rawParts JSON for every message across every chat.
 * Full messages are loaded on demand by getChatDb when a chat is opened.
 */
export type ChatListItem = {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
};

export async function listChatMetadataDb(db: AppDatabase = defaultDb): Promise<ChatListItem[]> {
  const sessions = await db
    .select()
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt));

  return sessions.map((session) => ({
    id: session.id,
    title: session.title,
    pinned: Boolean(session.pinned),
    updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
  }));
}

export async function getChatDb(
  id: string,
  db: AppDatabase = defaultDb
): Promise<StoredChat | undefined> {
  const [session] = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, id));

  if (!session) return undefined;

  const messagesRows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, session.id))
    .orderBy(chatMessages.createdAt);

  const messages: UIMessage[] = messagesRows.map((r) => {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const parts = Array.isArray(meta._rawParts)
      ? (meta._rawParts as UIMessage["parts"])
      : [
          {
            type: "text" as const,
            text: r.content,
          },
        ];

    return {
      id: r.id,
      role: r.role as "user" | "assistant" | "system",
      parts,
      metadata: (meta.usage || meta.data ? meta : undefined) as UIMessage["metadata"],
    };
  });

  return {
    id: session.id,
    title: session.title,
    pinned: Boolean(session.pinned),
    updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
    messages,
  };
}

export async function saveChatDb(
  chat: StoredChat,
  db: AppDatabase = defaultDb,
  opts?: { ifUpdatedAt?: number },
): Promise<boolean> {
  const now = new Date(chat.updatedAt || Date.now());

  let affected = 0;
  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, chat.id))
      .all();

    if (existing.length === 0) {
      tx.insert(chatSessions).values({
        id: chat.id,
        title: chat.title,
        pinned: Boolean(chat.pinned),
        createdAt: now,
        updatedAt: now,
      }).run();
      affected = 1;
    } else {
      const updateQuery = tx
        .update(chatSessions)
        .set({
          title: chat.title,
          pinned: Boolean(chat.pinned),
          updatedAt: now,
        })
        .where(
          opts?.ifUpdatedAt != null
            ? and(eq(chatSessions.id, chat.id), eq(chatSessions.updatedAt, new Date(opts.ifUpdatedAt)))
            : eq(chatSessions.id, chat.id),
        );

      const result = updateQuery.run();
      affected = result.changes;
    }

    // Sync messages: delete removed ones, then upsert
    const currentMessageIds = chat.messages.map((m) => m.id);
    if (currentMessageIds.length > 0) {
      tx.delete(chatMessages)
        .where(
          and(
            eq(chatMessages.sessionId, chat.id),
            notInArray(chatMessages.id, currentMessageIds)
          )
        )
        .run();
    } else {
      tx.delete(chatMessages)
        .where(eq(chatMessages.sessionId, chat.id))
        .run();
    }

    if (chat.messages.length === 0) return;

    // Fetch existing message IDs in a single batch query (eliminates N+1 select queries)
    const existingMessageIds = new Set(
      tx
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.sessionId, chat.id),
            inArray(chatMessages.id, currentMessageIds)
          )
        )
        .all()
        .map((r) => r.id)
    );

    for (const message of chat.messages) {
      const textContent = message.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      const metadataToSave: Record<string, unknown> = {
        ...(message.metadata as Record<string, unknown> ?? {}),
        _rawParts: message.parts,
      };

      if (!existingMessageIds.has(message.id)) {
        tx.insert(chatMessages).values({
          id: message.id,
          sessionId: chat.id,
          role: message.role as "user" | "assistant" | "system",
          content: textContent,
          metadata: metadataToSave,
        }).run();
      } else {
        // Update settled/regenerated messages
        tx
          .update(chatMessages)
          .set({
            content: textContent,
            metadata: metadataToSave,
          })
          .where(eq(chatMessages.id, message.id))
          .run();
      }
    }
  });

  return affected > 0;
}

export async function deleteChatDb(
  id: string,
  db: AppDatabase = defaultDb
): Promise<void> {
  await db.delete(chatSessions).where(eq(chatSessions.id, id));
}

/**
 * Delete many chats by id in a single transaction. chat_messages rows
 * cascade via FK. Returns the number of sessions actually removed —
 * callers use it to detect stale-id payloads (already deleted elsewhere)
 * without treating that as an error.
 */
export async function deleteChatsBulkDb(
  ids: string[],
  db: AppDatabase = defaultDb
): Promise<number> {
  if (ids.length === 0) return 0;
  // Single transaction: either the whole batch goes or nothing does —
  // a mid-batch failure can never leave a half-deleted set behind.
  return db.transaction((tx) => {
    const result = tx
      .delete(chatSessions)
      .where(inArray(chatSessions.id, ids))
      .run();
    return result.changes;
  });
}

/**
 * Update chat metadata (title and/or pinned) without touching messages.
 * Returns false when no chat with that id exists.
 */
export async function updateChatMetaDb(
  id: string,
  patch: { title?: string; pinned?: boolean },
  db: AppDatabase = defaultDb
): Promise<boolean> {
  const updates: { title?: string; pinned?: boolean; updatedAt?: Date } = {};
  if (typeof patch.title === "string") {
    const title = patch.title.trim();
    if (!title) return false;
    updates.title = title.slice(0, 120);
  }
  if (typeof patch.pinned === "boolean") {
    updates.pinned = patch.pinned;
  }
  if (Object.keys(updates).length === 0) return false;
  // Bump updatedAt so meta edits made in one tab propagate to other tabs'
  // sync merges (which keep the local row when its updatedAt is >= the
  // server's). Without this, renames and pins never crossed tabs.
  updates.updatedAt = new Date();

  const result = db
    .update(chatSessions)
    .set(updates)
    .where(eq(chatSessions.id, id))
    .run();
  return result.changes > 0;
}

/**
 * ── Resumable-stream pointers ──────────────────────────────────────
 * The chat route publishes each generation's SSE stream under a
 * streamId (stream-registry) and records it here while it runs. The
 * GET /api/chat/[id]/stream resume endpoint reads the pointer; the
 * stop endpoint clears it. `setActiveStreamId` returning false means
 * the chat does not exist (deleted mid-run) — callers must then not
 * register resumption for it.
 */

export async function setActiveStreamIdDb(
  chatId: string,
  streamId: string,
  db: AppDatabase = defaultDb
): Promise<boolean> {
  const result = db
    .update(chatSessions)
    .set({ activeStreamId: streamId })
    .where(eq(chatSessions.id, chatId))
    .run();
  return result.changes > 0;
}

/**
 * Clear the active-stream pointer. `onlyIf` guards the stop-endpoint
 * race: a stop arriving after a NEWER stream started must not clear
 * the newer pointer — pass the streamId the stop request saw.
 */
export async function clearActiveStreamIdDb(
  chatId: string,
  onlyIf?: string,
  db: AppDatabase = defaultDb
): Promise<void> {
  const condition =
    onlyIf != null
      ? and(eq(chatSessions.id, chatId), eq(chatSessions.activeStreamId, onlyIf))
      : eq(chatSessions.id, chatId);
  db.update(chatSessions).set({ activeStreamId: null }).where(condition).run();
}

export async function getActiveStreamIdDb(
  chatId: string,
  db: AppDatabase = defaultDb
): Promise<string | null> {
  const row = db
    .select({ activeStreamId: chatSessions.activeStreamId })
    .from(chatSessions)
    .where(eq(chatSessions.id, chatId))
    .get();
  return row?.activeStreamId ?? null;
}

/**
 * Upsert per-message feedback ("positive" | "negative" | null). Reads the
 * existing metadata JSON, merges the feedback key, and writes it back.
 * Null removes the key so it does not pollute stored data.
 * Returns false when the message id does not exist (no rows changed).
 */
export async function upsertMessageFeedbackDb(
  messageId: string,
  feedback: "positive" | "negative" | null,
  db: AppDatabase = defaultDb
): Promise<boolean> {
  // Read existing metadata to merge — SQLite has no native JSON field update
  const existing = db
    .select({ metadata: chatMessages.metadata })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .get();

  if (!existing) return false;

  const meta: Record<string, unknown> = {
    ...((existing.metadata as Record<string, unknown> | null) ?? {}),
  };

  if (feedback === null) {
    delete meta.feedback;
  } else {
    meta.feedback = feedback;
  }

  const result = db
    .update(chatMessages)
    .set({ metadata: meta })
    .where(eq(chatMessages.id, messageId))
    .run();

  return result.changes > 0;
}
