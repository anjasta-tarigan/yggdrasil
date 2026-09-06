import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { upsertMessageFeedbackDb } from "@/lib/chat-service";

describe("Feedback integration: DB persistence and lifecycle", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema });

    // Seed session + assistant message with existing usage metadata
    sqlite
      .prepare(
        "INSERT INTO chat_sessions (id, title, pinned, created_at, updated_at) VALUES (?, ?, 0, 1000, 1000)"
      )
      .run("chat-1", "Integration Chat");

    sqlite
      .prepare(
        "INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, 1000)"
      )
      .run(
        "msg-1",
        "chat-1",
        "assistant",
        "Here is the answer to your question.",
        JSON.stringify({ usage: { inputTokens: 42, outputTokens: 128 } })
      );
  });

  it("completes full feedback lifecycle: set positive -> change to negative -> clear", async () => {
    // 1. Set positive feedback
    const ok1 = await upsertMessageFeedbackDb("msg-1", "positive", db);
    expect(ok1).toBe(true);

    let row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    let meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("positive");
    // Token usage must survive
    expect(meta.usage).toEqual({ inputTokens: 42, outputTokens: 128 });

    // 2. Change to negative feedback (overwrite)
    const ok2 = await upsertMessageFeedbackDb("msg-1", "negative", db);
    expect(ok2).toBe(true);

    row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("negative");
    expect(meta.usage).toEqual({ inputTokens: 42, outputTokens: 128 });

    // 3. Clear feedback (toggle off)
    const ok3 = await upsertMessageFeedbackDb("msg-1", null, db);
    expect(ok3).toBe(true);

    row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBeUndefined();
    // Token usage must still survive after clearing
    expect(meta.usage).toEqual({ inputTokens: 42, outputTokens: 128 });
  });

  it("handles non-existent message gracefully", async () => {
    const ok = await upsertMessageFeedbackDb("non-existent-msg", "positive", db);
    expect(ok).toBe(false);
  });
});
