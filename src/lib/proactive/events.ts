import { nanoid } from "nanoid";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { syslog } from "@/lib/observability/log-store";
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

/**
 * Create an event only if no event of `kind` exists for `chatId` within
 * `cooldownSeconds`. The existence check and the insert run in one
 * synchronous transaction, so a manual run racing the hourly daemon cannot
 * both pass the check and double-emit (check-then-act across an `await`
 * allowed exactly that).
 *
 * @returns the new event id, or `null` when still within the cooldown.
 */
export function createProactiveEventIfNotRecent(
  input: ProactiveEventInput & {
    kind: "reminder" | "system";
    cooldownSeconds: number;
    /** Optional extra cooldown scope: only match events whose title contains this. */
    titleContains?: string;
  },
  db: AppDatabase = defaultDb
): string | null {
  const chatId = input.chatId ?? null;
  return db.transaction((tx) => {
    const conditions = [
      chatId === null
        ? isNull(proactiveEvents.chatId)
        : eq(proactiveEvents.chatId, chatId),
      eq(proactiveEvents.kind, input.kind),
      sql`strftime('%s', 'now') - ${proactiveEvents.createdAt} < ${input.cooldownSeconds}`,
    ];
    if (input.titleContains) {
      conditions.push(
        sql`${proactiveEvents.title} LIKE ${`%${input.titleContains}%`}`
      );
    }

    const recent = tx
      .select({ id: proactiveEvents.id })
      .from(proactiveEvents)
      .where(and(...conditions))
      .limit(1)
      .all();

    if (recent.length > 0) return null;

    const id = `evt_${nanoid(12)}`;
    tx.insert(proactiveEvents)
      .values({
        id,
        kind: input.kind,
        title: input.title.slice(0, 120),
        body: input.body ? input.body.slice(0, 500) : null,
        chatId,
      })
      .run();
    return id;
  });
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
  const created: ProactiveScanResult["events"] = [];

  // Durations in seconds. Timestamps in every memory/chat table are stored as
  // epoch SECONDS (SQLite integer), so all comparisons use direct integer
  // arithmetic: `strftime('%s','now') - column`. Wrapping the column in
  // strftime() returns NULL for an integer and makes the predicate always
  // false — that bug suppressed every proactive event.
  const staleThresholdSeconds = STALE_CONVERSATION_DAYS * 86400;
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
        sql`strftime('%s', 'now') - ${chatSessions.updatedAt} > ${staleThresholdSeconds}`
      )
      .orderBy(desc(chatSessions.updatedAt))
      .limit(5)
      .all();

    for (const chat of staleChats) {
      if (!chat.id) continue;
      // Atomic cooldown check + insert: a concurrent manual run cannot
      // double-emit the same reminder.
      const createdId = createProactiveEventIfNotRecent(
        {
          kind: "reminder",
          title: `Continue "${chat.title.slice(0, 40)}…"?`,
          body: `It's been a few days since we last talked about this. I've been consolidating memories and would love to pick up where we left off.`,
          chatId: chat.id,
          cooldownSeconds,
        },
        db
      );
      if (!createdId) continue; // still within cooldown

      created.push({
        title: `Stale conversation: ${chat.title}`,
        kind: "reminder",
      });
    }
  } catch (err) {
    syslog("warn", "proactive", "Stale conversation check failed: " + String(err));
  }

  // ── 2. Maintenance summary ──────────────────────────────────────────────
  try {
    const recentConsolidated = db
      .select({ count: sql`count(*)` })
      .from(semanticMemories)
      .where(
        and(
          sql`strftime('%s', 'now') - ${semanticMemories.createdAt} < ${cooldownSeconds}`,
          sql`${semanticMemories.tags} LIKE '%"consolidated_memory"%'`
        )
      )
      .all();

    const consolidatedCount = Number((recentConsolidated[0]?.count as unknown) ?? 0);

    if (consolidatedCount > 0) {
      // Atomic cooldown check + insert (see createProactiveEventIfNotRecent).
      const createdId = createProactiveEventIfNotRecent(
        {
          kind: "system",
          title: `Background maintenance complete`,
          body: `I consolidated ${consolidatedCount} new memory${consolidatedCount === 1 ? "" : "s"} and updated my knowledge graph while you were away.`,
          cooldownSeconds,
        },
        db
      );
      if (createdId) {
        created.push({
          title: "Maintenance summary",
          kind: "system",
        });
      }
    }
  } catch (err) {
    syslog("warn", "proactive", "Maintenance summary check failed: " + String(err));
  }

  // ── 3. Topic handoff summary ─────────────────────────────────────────────
  try {
    const recentHandoffs = db
      .select({ count: sql`count(*)` })
      .from(semanticMemories)
      .where(
        and(
          sql`strftime('%s', 'now') - ${semanticMemories.createdAt} < ${cooldownSeconds}`,
          sql`${semanticMemories.tags} LIKE '%"topic_handoff"%'`
        )
      )
      .all();

    const handoffCount = Number((recentHandoffs[0]?.count as unknown) ?? 0);

    if (handoffCount > 0) {
      // Atomic cooldown check + insert, scoped to topic-boundary titles.
      const createdId = createProactiveEventIfNotRecent(
        {
          kind: "system",
          title: `New topic boundaries detected (${handoffCount})`,
          body: `I noticed ${handoffCount} new topic boundary${handoffCount === 1 ? "" : "ies"} in our recent conversations. I've updated my memory segmentation to keep old topics from bleeding into new ones.`,
          cooldownSeconds,
          titleContains: "Topic boundary",
        },
        db
      );
      if (createdId) {
        created.push({
          title: "Topic handoff summary",
          kind: "system",
        });
      }
    }
  } catch (err) {
    syslog("warn", "proactive", "Topic handoff summary check failed: " + String(err));
  }

  return { created: created.length, events: created };
}
