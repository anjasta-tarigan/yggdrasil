import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import { generateApprovalSecret, resolveApprovalSecret } from "../approval-secret";

/**
 * Build a fresh in-memory SQLite DB wired with the real schema + FTS
 * triggers, mirroring the production settings table exactly. Each test
 * starts with a clean store so persistence is genuinely exercised.
 */
function makeDb(): AppDatabase {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupFtsAndTriggers(sqlite);
  return drizzle(sqlite, { schema });
}

describe("approval-secret", () => {
  describe("generateApprovalSecret()", () => {
    it("returns a 64-character hex string (32 bytes)", () => {
      const secret = generateApprovalSecret();
      expect(secret).toHaveLength(64);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns different values on each call", () => {
      const a = generateApprovalSecret();
      const b = generateApprovalSecret();
      const c = generateApprovalSecret();
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
      expect(b).not.toBe(c);
    });

    it("produces cryptographically random output (low collision rate)", () => {
      // 32 bytes = 256 bits of entropy; collisions among n samples must be
      // exactly zero. This guards against a broken RNG.
      const samples = new Set<string>();
      for (let i = 0; i < 200; i++) {
        samples.add(generateApprovalSecret());
      }
      expect(samples.size).toBe(200);
    });
  });

  describe("resolveApprovalSecret()", () => {
    let db: AppDatabase;

    beforeEach(() => {
      db = makeDb();
    });

    it("returns a 64-char hex string on first call (generates + persists)", () => {
      const secret = resolveApprovalSecret(db);
      expect(secret).toBeDefined();
      expect(secret).toHaveLength(64);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it("persists the secret so a second call returns the same value", () => {
      const first = resolveApprovalSecret(db);
      const second = resolveApprovalSecret(db);
      expect(first).toBe(second);
    });

    it("writes the secret to the settings store under 'tool_approval_secret'", () => {
      resolveApprovalSecret(db);
      const stored = getSettingDb("tool_approval_secret", db);
      expect(stored).toBeTypeOf("string");
      expect(stored as string).toHaveLength(64);
      expect(stored as string).toMatch(/^[0-9a-f]{64}$/);
    });

    it("round-trips: setSettingsDb with a pre-existing secret is reused, not overwritten", () => {
      const preExisting = generateApprovalSecret();
      setSettingsDb({ tool_approval_secret: preExisting }, db);

      const resolved = resolveApprovalSecret(db);
      expect(resolved).toBe(preExisting);
    });

    it("reuses the persisted secret across separate database handles", () => {
      // Simulate two server restarts: first call generates + persists,
      // a fresh in-memory DB seeded only from the settings row reuses it.
      resolveApprovalSecret(db);
      const stored = getSettingDb("tool_approval_secret", db);

      // New DB with the same persisted value "imported".
      const db2 = makeDb();
      setSettingsDb({ tool_approval_secret: stored }, db2);
      expect(resolveApprovalSecret(db2)).toBe(stored);
    });
  });
});
