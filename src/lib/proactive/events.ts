import { nanoid } from "nanoid";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { proactiveEvents } from "@/db/schema";

/**
 * Proactive events: the server-side surface through which the assistant
 * speaks first. The `scheduled_reminder` job handler writes reminder
 * events; the UI inbox polls `/api/events` and marks them read.
 */

export interface ProactiveEventInput {
  kind?: "reminder" | "system";
  title: string;
  body?: string | null;
  chatId?: string | null;
}

export async function createProactiveEvent(
  input: ProactiveEventInput,
  db: AppDatabase = defaultDb
): Promise<string> {
  const id = `evt_${nanoid(12)}`;
  await db.insert(proactiveEvents).values({
    id,
    kind: input.kind ?? "reminder",
    title: input.title.slice(0, 120),
    body: input.body ? input.body.slice(0, 500) : null,
    chatId: input.chatId ?? null,
  });
  return id;
}

export async function listUnreadEvents(
  options: { limit?: number; db?: AppDatabase } = {}
) {
  const limit = options.limit ?? 50;
  const db = options.db ?? defaultDb;
  return db
    .select()
    .from(proactiveEvents)
    .where(isNull(proactiveEvents.readAt))
    .orderBy(desc(proactiveEvents.createdAt))
    .limit(limit);
}

export async function markEventRead(
  id: string,
  db: AppDatabase = defaultDb
): Promise<boolean> {
  const result = await db
    .update(proactiveEvents)
    .set({ readAt: new Date() })
    .where(and(eq(proactiveEvents.id, id), isNull(proactiveEvents.readAt)))
    .run();
  return (result.changes ?? 0) > 0;
}

export async function markAllEventsRead(
  db: AppDatabase = defaultDb
): Promise<number> {
  const result = await db
    .update(proactiveEvents)
    .set({ readAt: new Date() })
    .where(isNull(proactiveEvents.readAt))
    .run();
  return result.changes ?? 0;
}
