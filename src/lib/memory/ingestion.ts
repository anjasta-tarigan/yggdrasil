import { desc, eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { chatSessions, episodicMemories } from "@/db/schema";
import { addEpisodicMemory } from "./episodic-memory";
import { generateEmbedding, vectorToBuffer } from "./embeddings";
import { shouldReflectOnTurn } from "./reflection";
import { enqueueJob } from "@/lib/queue/queue";
import { syslog } from "@/lib/observability/log-store";

/**
 * Chat-turn ingestion — the wire between live conversations and the memory
 * loop. Every finished chat turn is written to episodic memory (with an
 * embedding so FTS5 + vector search can retrieve it), and turns that pass
 * the reflection heuristics additionally enqueue a `reflect_turn` job for
 * fact / procedural-rule extraction into semantic memory.
 *
 * Ingestion runs as a durable background job (`ingest_turn`) so it never
 * blocks the chat stream and survives server restarts.
 */

export interface IngestionPayload {
  sessionId?: string;
  userPrompt: string;
  assistantResponse: string;
  /** Total user messages in the conversation when the turn finished. */
  userMessagesCount?: number;
}

export interface IngestionResult {
  episodicMemoryId: string | null;
  reflectionQueued: boolean;
  /** True when this turn replaced a duplicate instead of inserting a new row. */
  deduplicated?: boolean;
}

/** Episodic rows are retrieval fodder, not deliverables — bound their size. */
const MAX_USER_CHARS = 2000;
const MAX_ASSISTANT_CHARS = 4000;

/**
 * Regenerating a response re-fires the ingestion for the same user turn.
 * Within this window a turn with an identical user prompt is treated as a
 * re-ingestion of the same turn: the existing memory is updated in place
 * instead of accumulating near-duplicate rows.
 */
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const DEDUP_LOOKBACK_ROWS = 6;

function truncateForMemory(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}… [truncated]`;
}

/**
 * `episodic_memories.session_id` is a foreign key into `chat_sessions`, but
 * ingestion races the client's chat-save request: the queue runner can pick
 * up the job before the browser has persisted the session row. Create a
 * placeholder session when it is missing so the memory keeps its session
 * linkage; the client's subsequent save upserts over it with the real title.
 */
function ensureChatSessionExists(
  db: AppDatabase,
  sessionId: string | undefined
): void {
  if (!sessionId) return;
  try {
    db.insert(chatSessions)
      .values({ id: sessionId, title: "Untitled chat" })
      .onConflictDoNothing()
      .run();
  } catch (err) {
    // If the driver or dialect doesn't support onConflictDoNothing in some context, ignore duplicate insertion errors
    console.warn("[ingestion] ensureChatSessionExists conflict ignored:", err);
  }
}

/**
 * Finds a recently ingested turn in the same session with an identical
 * user prompt (the signature of a regenerated response). Only rows inside
 * the dedup window are considered; the user prompt alone identifies the
 * turn because the assistant text legitimately differs per regeneration.
 */
function findRecentDuplicate(
  db: AppDatabase,
  sessionId: string | undefined,
  user: string
): { id: string } | undefined {
  if (!sessionId || !user) return undefined;
  const prefix = `User: ${user}\n`;
  const cutoff = Date.now() - DEDUP_WINDOW_MS;

  const recent = db
    .select({
      id: episodicMemories.id,
      content: episodicMemories.content,
      createdAt: episodicMemories.createdAt,
    })
    .from(episodicMemories)
    .where(eq(episodicMemories.sessionId, sessionId))
    .orderBy(desc(episodicMemories.createdAt))
    .limit(DEDUP_LOOKBACK_ROWS)
    .all();

  return recent.find(
    (row) =>
      row.content.startsWith(prefix) &&
      new Date(row.createdAt).getTime() >= cutoff
  );
}

/**
 * Persists one chat turn into episodic memory and conditionally queues
 * reflection. Malformed or empty payloads are skipped, not failed — a bad
 * payload would otherwise burn its whole retry budget for nothing.
 */
export async function executeTurnIngestion(
  payload: IngestionPayload,
  db: AppDatabase = defaultDb
): Promise<IngestionResult> {
  const userPrompt =
    typeof payload?.userPrompt === "string" ? payload.userPrompt : "";
  const assistantResponse =
    typeof payload?.assistantResponse === "string"
      ? payload.assistantResponse
      : "";

  const user = truncateForMemory(userPrompt, MAX_USER_CHARS);
  const assistant = truncateForMemory(assistantResponse, MAX_ASSISTANT_CHARS);

  if (!user && !assistant) {
    return { episodicMemoryId: null, reflectionQueued: false };
  }

  const content = `User: ${user}\nAssistant: ${assistant}`;

  // Regenerated response for an already-ingested turn: update the existing
  // memory in place (recomputing its embedding vector) and skip a second reflection for the same turn.
  const duplicate = findRecentDuplicate(db, payload?.sessionId, user);
  if (duplicate) {
    const embedding = await generateEmbedding(content);
    db.update(episodicMemories)
      .set({
        content,
        embedding: embedding ? vectorToBuffer(embedding) : null,
      })
      .where(eq(episodicMemories.id, duplicate.id))
      .run();
    syslog(
      "debug",
      "ingestion",
      `Regenerated turn deduplicated into episodic memory ${duplicate.id}`
    );
    return {
      episodicMemoryId: duplicate.id,
      reflectionQueued: false,
      deduplicated: true,
    };
  }

  const embedding = await generateEmbedding(content);

  ensureChatSessionExists(db, payload?.sessionId);

  // Turns worth reflecting on (corrections, preferences, milestones) are
  // also worth remembering a little better — the importance boost helps
  // them survive the Ebbinghaus decay sweep.
  const turnCount =
    typeof payload?.userMessagesCount === "number"
      ? payload.userMessagesCount
      : 0;
  const reflectionWorthy = shouldReflectOnTurn(user, turnCount);

  const episodicMemoryId = await addEpisodicMemory(
    {
      sessionId: payload?.sessionId,
      content,
      embedding,
      importance: reflectionWorthy ? 0.65 : 0.5,
      tags: ["chat_turn"],
      metadata: { extractedFrom: "chat_turn_ingestion" },
    },
    db
  );

  let reflectionQueued = false;
  if (reflectionWorthy) {
    await enqueueJob(
      {
        type: "reflect_turn",
        payload: {
          sessionId: payload?.sessionId,
          userPrompt: user,
          assistantResponse: assistant,
        },
      },
      db
    );
    reflectionQueued = true;
  }

  return { episodicMemoryId, reflectionQueued };
}
