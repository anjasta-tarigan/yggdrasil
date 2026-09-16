import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { getSettingDb, getSettingsDb, setSettingsDb } from "../settings-service";

describe("Settings Service (SQLite key/value store)", () => {
  let sqlite: Database.Database;
  let testDb: AppDatabase;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("returns undefined for unknown keys", () => {
    expect(getSettingDb("missing", testDb)).toBeUndefined();
  });

  it("stores and reads JSON values round-trip", () => {
    const providers = [
      {
        id: "ollama-1",
        kind: "ollama",
        name: "Ollama",
        baseUrl: "http://localhost:11434",
      },
    ];
    setSettingsDb({ providers, embedding: { model: "nomic-embed-text" } }, testDb);

    expect(getSettingDb("providers", testDb)).toEqual(providers);
    expect(getSettingDb("embedding", testDb)).toEqual({
      model: "nomic-embed-text",
    });
  });

  it("lists all settings as a plain object", () => {
    setSettingsDb({ a: 1, b: "two", c: { three: 3 } }, testDb);
    expect(getSettingsDb(testDb)).toEqual({ a: 1, b: "two", c: { three: 3 } });
  });

  it("upserts existing keys", () => {
    setSettingsDb({ embedding: { model: "first" } }, testDb);
    setSettingsDb({ embedding: { model: "second" } }, testDb);
    expect(getSettingDb("embedding", testDb)).toEqual({ model: "second" });
    expect(Object.keys(getSettingsDb(testDb))).toEqual(["embedding"]);
  });

  it("deletes keys when the patch value is undefined", () => {
    setSettingsDb({ a: 1, b: 2 }, testDb);
    setSettingsDb({ a: undefined }, testDb);
    expect(getSettingDb("a", testDb)).toBeUndefined();
    expect(getSettingDb("b", testDb)).toBe(2);
  });

  it("encrypts sensitive keys in SQLite at rest and decrypts transparently on read", () => {
    const providers = [
      {
        id: "anthropic-1",
        kind: "anthropic",
        name: "Anthropic",
        apiKey: "sk-ant-test-live-key-12345",
        nested: {
          token: "nested-access-token",
        },
      },
    ];

    setSettingsDb({ providers }, testDb);

    // Inspect raw SQLite row using raw SQL to verify encryption at rest
    const rawRow = sqlite
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("providers") as { value: string };

    expect(rawRow).toBeDefined();
    expect(rawRow.value).toContain("enc:v1:");
    expect(rawRow.value).not.toContain("sk-ant-test-live-key-12345");
    expect(rawRow.value).not.toContain("nested-access-token");

    // Transparent plaintext decryption on getSettingDb
    const read = getSettingDb("providers", testDb) as typeof providers;
    expect(read).toEqual(providers);
    expect(read[0].apiKey).toBe("sk-ant-test-live-key-12345");
    expect(read[0].nested.token).toBe("nested-access-token");

    // Transparent plaintext decryption on getSettingsDb
    const all = getSettingsDb(testDb) as { providers: typeof providers };
    expect(all.providers).toEqual(providers);
    expect(all.providers[0].apiKey).toBe("sk-ant-test-live-key-12345");
  });
});
