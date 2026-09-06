import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";
import { upsertMessageFeedbackDb } from "@/lib/chat-service";

describe("upsertMessageFeedbackDb", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema });

    sqlite
      .prepare(
        "INSERT INTO chat_sessions (id, title, pinned, created_at, updated_at) VALUES (?, ?, 0, 1000, 1000)"
      )
      .run("sess-1", "Test Session");
    sqlite
      .prepare(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, 1000)"
      )
      .run("msg-1", "sess-1", "assistant", "Hello");
  });

  it("sets positive feedback on a message with no existing metadata", async () => {
    const ok = await upsertMessageFeedbackDb("msg-1", "positive", db);
    expect(ok).toBe(true);

    const row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("positive");
  });

  it("updates existing feedback from positive to negative", async () => {
    await upsertMessageFeedbackDb("msg-1", "positive", db);
    const ok = await upsertMessageFeedbackDb("msg-1", "negative", db);
    expect(ok).toBe(true);

    const row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("negative");
  });

  it("clears feedback when setting to null", async () => {
    await upsertMessageFeedbackDb("msg-1", "positive", db);
    const ok = await upsertMessageFeedbackDb("msg-1", null, db);
    expect(ok).toBe(true);

    const row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBeUndefined();
  });

  it("returns false for a non-existent message id", async () => {
    const ok = await upsertMessageFeedbackDb("no-such-msg", "positive", db);
    expect(ok).toBe(false);
  });

  it("preserves existing metadata keys when updating feedback", async () => {
    sqlite
      .prepare("UPDATE chat_messages SET metadata = ? WHERE id = ?")
      .run(JSON.stringify({ usage: { inputTokens: 10 } }), "msg-1");

    await upsertMessageFeedbackDb("msg-1", "negative", db);

    const row = sqlite
      .prepare("SELECT metadata FROM chat_messages WHERE id = ?")
      .get("msg-1") as { metadata: string | null };
    const meta = JSON.parse(row.metadata ?? "{}");
    expect(meta.feedback).toBe("negative");
    expect(meta.usage).toEqual({ inputTokens: 10 });
  });
});
