import { nanoid } from "nanoid";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { chatSessions, proactiveEvents, semanticMemories } from "@/db/schema";

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

/**
 * Result of a proactive-event scan pass.
 */
export type ProactiveScanResult = {
  created: number;
  events: Array<{ title: string; kind: "reminder" | "system" }>;
};

/**
 * The main entry point for the `proactive_event_check` queue job.
 *
 * Scans for conditions that warrant surfacing events to the user:
 *
 * 1. **Stale conversation reminder** — a chat session whose last message
 *    is older than `STALE_CONVERSATION_DAYS` (default 3) and that has
 *    unread proactive events gets a reminder nudge to re-engage.
 *
 * 2. **Maintenance summary system event** — counts consolidated semantic
 *    memories created in the last pass window and emits a system event
 *    summarising the background work done.
 *
 * 3. **Anti-spam cooldown** — each event kind has a dedup window so the
 *    same condition doesn't produce repeated events every hour.
 */
export async function generateProactiveEvents(
  db: AppDatabase = defaultDb
): Promise<ProactiveScanResult> {
  const STALE_CONVERSATION_DAYS = 3;
  const COOLDOWN_HOURS = 24;
  const now = new Date();
  const created: ProactiveScanResult["events"] = [];

  const staleThresholdSeconds = Math.floor(
    now.getTime() / 1000 - STALE_CONVERSATION_DAYS * 86400
  );
  const cooldownSeconds = COOLDOWN_HOURS * 3600;

  // ── 1. Stale conversation reminder ──────────────────────────────────────
  try {
    const staleChats = db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        updatedAt: chatSessions.updatedAt,
      })
      .from(chatSessions)
      .where(
        sql`strftime('%s', 'now') - strftime('%s', ${chatSessions.updatedAt}) > ${staleThresholdSeconds}`
      )
      .orderBy(desc(chatSessions.updatedAt))
      .limit(5)
      .all();

    for (const chat of staleChats) {
      if (!chat.id) continue;
      // Cooldown: don't re-nudge the same chat within COOLDOWN_HOURS.
      const recent = db
        .select({ id: proactiveEvents.id })
        .from(proactiveEvents)
        .where(
          and(
            eq(proactiveEvents.chatId, chat.id),
            eq(proactiveEvents.kind, "reminder"),
            gte(
              sql`strftime('%s', 'now') - strftime('%s', ${proactiveEvents.createdAt})`,
              0
            ),
            sql`strftime('%s', 'now') - strftime('%s', ${proactiveEvents.createdAt}) < ${cooldownSeconds}`
          )
        )
        .limit(1)
        .all();

      if (recent.length > 0) continue; // still within cooldown

      await createProactiveEvent(
        {
          kind: "reminder",
          title: `Continue "${chat.title.slice(0, 40)}…"?`,
          body: `It's been a few days since we last talked about this. I've been consolidating memories and would love to pick up where we left off.`,
          chatId: chat.id,
        },
        db
      );
      created.push({
        title: `Stale conversation: ${chat.title}`,
        kind: "reminder",
      });
    }
  } catch (err) {
    console.warn("[proactive] Stale conversation check failed:", err);
  }

  // ── 2. Maintenance summary ──────────────────────────────────────────────
  try {
    const recentConsolidated = db
      .select({ count: sql`count(*)` })
      .from(semanticMemories)
      .where(
        and(
          sql`strftime('%s', 'now') - strftime('%s', ${semanticMemories.createdAt}) < ${cooldownSeconds}`,
          sql`${semanticMemories.tags} LIKE '%"consolidated_memory"%'`
        )
      )
      .all();

    const consolidatedCount = Number((recentConsolidated[0]?.count as unknown) ?? 0);

    if (consolidatedCount > 0) {
      // Cooldown: don't repeat the maintenance summary.
      const recentSummary = db
        .select({ id: proactiveEvents.id })
        .from(proactiveEvents)
        .where(
          and(
            eq(proactiveEvents.kind, "system"),
            sql`strftime('%s', 'now') - strftime('%s', ${proactiveEvents.createdAt}) < ${cooldownSeconds}`
          )
        )
        .limit(1)
        .all();

      if (recentSummary.length === 0) {
        await createProactiveEvent(
          {
            kind: "system",
            title: `Background maintenance complete`,
            body: `I consolidated ${consolidatedCount} new memory${consolidatedCount === 1 ? "" : "s"} and updated my knowledge graph while you were away.`,
          },
          db
        );
        created.push({
          title: "Maintenance summary",
          kind: "system",
        });
      }
    }
  } catch (err) {
    console.warn("[proactive] Maintenance summary check failed:", err);
  }

  // ── 3. Topic handoff summary ─────────────────────────────────────────────
  try {
    const recentHandoffs = db
      .select({ count: sql`count(*)` })
      .from(semanticMemories)
      .where(
        and(
          sql`strftime('%s', 'now') - strftime('%s', ${semanticMemories.createdAt}) < ${cooldownSeconds}`,
          sql`${semanticMemories.tags} LIKE '%"topic_handoff"%'`
        )
      )
      .all();

    const handoffCount = Number((recentHandoffs[0]?.count as unknown) ?? 0);

    if (handoffCount > 0) {
      const recentHandoffEvent = db
        .select({ id: proactiveEvents.id })
        .from(proactiveEvents)
        .where(
          and(
            eq(proactiveEvents.kind, "system"),
            sql`${proactiveEvents.title} LIKE '%Topic boundary%'`,
            sql`strftime('%s', 'now') - strftime('%s', ${proactiveEvents.createdAt}) < ${cooldownSeconds}`
          )
        )
        .limit(1)
        .all();

      if (recentHandoffEvent.length === 0) {
        await createProactiveEvent(
          {
            kind: "system",
            title: `New topic boundaries detected (${handoffCount})`,
            body: `I noticed ${handoffCount} new topic boundary${handoffCount === 1 ? "" : "ies"} in our recent conversations. I've updated my memory segmentation to keep old topics from bleeding into new ones.`,
          },
          db
        );
        created.push({
          title: "Topic handoff summary",
          kind: "system",
        });
      }
    }
  } catch (err) {
    console.warn("[proactive] Topic handoff summary check failed:", err);
  }

  return { created: created.length, events: created };
}
