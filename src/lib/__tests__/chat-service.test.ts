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
  updateChatMetaDb,
  setActiveStreamIdDb,
  clearActiveStreamIdDb,
  getActiveStreamIdDb,
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

  it("updates chat metadata without touching messages", async () => {
    await saveChatDb(
      {
        id: "chat-meta",
        title: "Before rename",
        updatedAt: Date.now(),
        messages: [
          {
            id: "m1",
            role: "user" as const,
            parts: [{ type: "text" as const, text: "Keep me" }],
          },
        ],
      },
      testDb
    );

    expect(
      await updateChatMetaDb("chat-meta", { title: "After rename" }, testDb)
    ).toBe(true);
    expect(await updateChatMetaDb("chat-meta", { pinned: true }, testDb)).toBe(
      true
    );

    const loaded = await getChatDb("chat-meta", testDb);
    expect(loaded?.title).toBe("After rename");
    expect(loaded?.pinned).toBe(true);
    expect(loaded?.messages.length).toBe(1);
    expect(loaded?.messages[0].parts[0]).toEqual({
      type: "text",
      text: "Keep me",
    });
  });

  it("returns false when updating metadata of a missing chat", async () => {
    expect(await updateChatMetaDb("nope", { pinned: true }, testDb)).toBe(
      false
    );
  });

  it("rejects empty metadata patches", async () => {
    await saveChatDb(
      {
        id: "chat-empty-patch",
        title: "T",
        updatedAt: Date.now(),
        messages: [],
      },
      testDb
    );
    expect(await updateChatMetaDb("chat-empty-patch", {}, testDb)).toBe(false);
    expect(
      await updateChatMetaDb("chat-empty-patch", { title: "   " }, testDb)
    ).toBe(false);
  });

  describe("active stream pointers (resumable streams)", () => {
    const seed = async (id: string) =>
      saveChatDb(
        {
          id,
          title: "Stream chat",
          updatedAt: Date.now(),
          messages: [
            {
              id: "m1",
              role: "user" as const,
              parts: [{ type: "text" as const, text: "hi" }],
            },
          ],
        },
        testDb
      );

    it("set/get/clear round-trips the pointer", async () => {
      await seed("chat-stream-1");
      expect(await getActiveStreamIdDb("chat-stream-1", testDb)).toBeNull();

      expect(
        await setActiveStreamIdDb("chat-stream-1", "s-1", testDb)
      ).toBe(true);
      expect(await getActiveStreamIdDb("chat-stream-1", testDb)).toBe("s-1");

      await clearActiveStreamIdDb("chat-stream-1", undefined, testDb);
      expect(await getActiveStreamIdDb("chat-stream-1", testDb)).toBeNull();
    });

    it("setActiveStreamIdDb reports false for a missing chat", async () => {
      expect(await setActiveStreamIdDb("ghost", "s-x", testDb)).toBe(false);
    });

    it("clear with onlyIf clears the pointer only when it matches", async () => {
      await seed("chat-stream-2");
      await setActiveStreamIdDb("chat-stream-2", "s-current", testDb);

      // A stale clear naming an older stream must not touch it.
      await clearActiveStreamIdDb("chat-stream-2", "s-old", testDb);
      expect(await getActiveStreamIdDb("chat-stream-2", testDb)).toBe(
        "s-current"
      );

      // Clearing with the correct id succeeds.
      await clearActiveStreamIdDb("chat-stream-2", "s-current", testDb);
      expect(await getActiveStreamIdDb("chat-stream-2", testDb)).toBeNull();
    });

    it("pointer survives saveChatDb round-trips (settled turn re-save)", async () => {
      await seed("chat-stream-3");
      await setActiveStreamIdDb("chat-stream-3", "s-live", testDb);

      // The client's settle-save (full replace) must not drop the
      // active pointer: generation still running while the client
      // persists an older view.
      await saveChatDb(
        {
          id: "chat-stream-3",
          title: "Stream chat",
          updatedAt: Date.now(),
          messages: [
            {
              id: "m1",
              role: "user" as const,
              parts: [{ type: "text" as const, text: "hi" }],
            },
            {
              id: "m2",
              role: "user" as const,
              parts: [{ type: "text" as const, text: "again" }],
            },
          ],
        },
        testDb
      );
      expect(await getActiveStreamIdDb("chat-stream-3", testDb)).toBe(
        "s-live"
      );
    });
  });
});
