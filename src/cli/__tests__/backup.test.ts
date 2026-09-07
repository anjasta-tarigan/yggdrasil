import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { backupDatabaseFiles, restoreDatabaseFiles } from "../utils/backup";

describe("SQLite WAL-Safe Backup and Restore", () => {
  const tmpDir = path.join(os.tmpdir(), "ygg-backup-test-" + Date.now());
  const dataDir = path.join(tmpDir, "data");
  const backupDir = path.join(tmpDir, "backups");

  beforeEach(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("safely backs up and restores .db, -wal, and -shm files", async () => {
    const dbPath = path.join(dataDir, "yggdrasil.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);");
    db.exec("INSERT INTO items (name) VALUES ('original');");
    db.close();

    // Create companion files if not automatically created
    const walPath = path.join(dataDir, "yggdrasil.db-wal");
    const shmPath = path.join(dataDir, "yggdrasil.db-shm");
    if (!(await fs.stat(walPath).catch(() => false))) {
      await fs.writeFile(walPath, "dummy-wal", "utf8");
    }
    if (!(await fs.stat(shmPath).catch(() => false))) {
      await fs.writeFile(shmPath, "dummy-shm", "utf8");
    }

    const backedUp = await backupDatabaseFiles(dataDir, backupDir);
    expect(backedUp.length).toBeGreaterThanOrEqual(1);

    // Now corrupt/modify original DB
    const db2 = new Database(dbPath);
    db2.exec("INSERT INTO items (name) VALUES ('corrupted_or_newer');");
    db2.close();

    // Restore from backup
    await restoreDatabaseFiles(backupDir, dataDir);

    const db3 = new Database(dbPath);
    const rows = db3.prepare("SELECT name FROM items").all() as { name: string }[];
    db3.close();

    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("original");
  });
});
