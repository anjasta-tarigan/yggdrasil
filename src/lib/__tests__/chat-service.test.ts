import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import {
  listChatsDb,
  getChatDb,
  saveChatDb,
  deleteChatDb,
} from "../chat-service";

describe("Chat Service (SQLite Persistence)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("saves, lists, and loads chats with messages", async () => {
    const chat = {
      id: "chat-test-1",
      title: "First conversation",
      updatedAt: Date.now(),
      messages: [
        {
          id: "m1",
          role: "user" as const,
          parts: [{ type: "text" as const, text: "Hello AI" }],
        },
        {
          id: "m2",
          role: "assistant" as const,
          parts: [{ type: "text" as const, text: "Hello human" }],
        },
      ],
    };

    await saveChatDb(chat, testDb);

    const chats = await listChatsDb(testDb);
    expect(chats.length).toBe(1);
    expect(chats[0].id).toBe("chat-test-1");
    expect(chats[0].title).toBe("First conversation");

    const loaded = await getChatDb("chat-test-1", testDb);
    expect(loaded).toBeDefined();
    expect(loaded?.messages.length).toBe(2);
    expect(loaded?.messages[0].parts[0]).toEqual({ type: "text", text: "Hello AI" });
  });

  it("deletes chat and cascades to messages", async () => {
    await saveChatDb(
      {
        id: "chat-delete-me",
        title: "Delete test",
        updatedAt: Date.now(),
        messages: [
          {
            id: "m1",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "Bye" }],
          },
        ],
      },
      testDb
    );

    await deleteChatDb("chat-delete-me", testDb);
    const chats = await listChatsDb(testDb);
    expect(chats.length).toBe(0);
  });
});
