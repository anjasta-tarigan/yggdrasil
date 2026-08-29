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
  db: AppDatabase = defaultDb
): Promise<void> {
  const now = new Date(chat.updatedAt || Date.now());

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
    } else {
      tx
        .update(chatSessions)
        .set({
          title: chat.title,
          pinned: Boolean(chat.pinned),
          updatedAt: now,
        })
        .where(eq(chatSessions.id, chat.id))
        .run();
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

    for (const message of chat.messages) {
      const textContent = message.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      const metadataToSave: Record<string, unknown> = {
        ...(message.metadata as Record<string, unknown> ?? {}),
        _rawParts: message.parts,
      };

      const [existingMessage] = tx
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, message.id))
        .all();

      if (!existingMessage) {
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
}

export async function deleteChatDb(
  id: string,
  db: AppDatabase = defaultDb
): Promise<void> {
  await db.delete(chatSessions).where(eq(chatSessions.id, id));
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
  const updates: { title?: string; pinned?: boolean } = {};
  if (typeof patch.title === "string") {
    const title = patch.title.trim();
    if (!title) return false;
    updates.title = title.slice(0, 120);
  }
  if (typeof patch.pinned === "boolean") {
    updates.pinned = patch.pinned;
  }
  if (Object.keys(updates).length === 0) return false;

  const result = db
    .update(chatSessions)
    .set(updates)
    .where(eq(chatSessions.id, id))
    .run();
  return result.changes > 0;
}

