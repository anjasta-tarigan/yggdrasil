import { eq, desc } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { chatSessions, chatMessages } from "@/db/schema";
import type { StoredChat } from "./chat-storage";
import type { UIMessage } from "ai";

export async function listChatsDb(db = defaultDb): Promise<StoredChat[]> {
  const sessions = await db
    .select()
    .from(chatSessions)
    .orderBy(desc(chatSessions.updatedAt));

  const result: StoredChat[] = [];

  for (const session of sessions) {
    const messagesRows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt);

    const messages: UIMessage[] = messagesRows.map((r: any) => ({
      id: r.id,
      role: r.role as any,
      parts: [
        {
          type: "text",
          text: r.content,
        },
      ],
      metadata: r.metadata ?? undefined,
    }));

    result.push({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
      messages,
    });
  }

  return result;
}

export async function getChatDb(
  id: string,
  db = defaultDb
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

  const messages: UIMessage[] = messagesRows.map((r: any) => ({
    id: r.id,
    role: r.role as any,
    parts: [
      {
        type: "text",
        text: r.content,
      },
    ],
    metadata: r.metadata ?? undefined,
  }));

  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
    messages,
  };
}

export async function saveChatDb(
  chat: StoredChat,
  db = defaultDb
): Promise<void> {
  const existing = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, chat.id));

  const now = new Date(chat.updatedAt || Date.now());

  if (existing.length === 0) {
    await db.insert(chatSessions).values({
      id: chat.id,
      title: chat.title,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db
      .update(chatSessions)
      .set({
        title: chat.title,
        updatedAt: now,
      })
      .where(eq(chatSessions.id, chat.id));
  }

  // Sync messages
  for (const message of chat.messages) {
    const textContent = message.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as any).text)
      .join("\n");

    const [existingMessage] = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, message.id));

    if (!existingMessage) {
      await db.insert(chatMessages).values({
        id: message.id,
        sessionId: chat.id,
        role: message.role as any,
        content: textContent,
        metadata: (message.metadata as any) ?? {},
      });
    }
  }
}

export async function deleteChatDb(
  id: string,
  db = defaultDb
): Promise<void> {
  await db.delete(chatSessions).where(eq(chatSessions.id, id));
}
