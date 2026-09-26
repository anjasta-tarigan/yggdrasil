import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { backupDatabaseFiles, restoreDatabaseFiles } from "../utils/backup";

describe("SQLite WAL-Safe Backup and Restore", () => {
  let tmpDir: string;
  let dataDir: string;
  let backupDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), "ygg-backup-test-" + crypto.randomUUID());
    dataDir = path.join(tmpDir, "data");
    backupDir = path.join(tmpDir, "backups");

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

  it("removes stale -wal and -shm files from dataDir when backup only has .db", async () => {
    const backupDbPath = path.join(backupDir, "yggdrasil.db");
    await fs.writeFile(backupDbPath, "dummy-backup-db", "utf8");

    const dataWalPath = path.join(dataDir, "yggdrasil.db-wal");
    const dataShmPath = path.join(dataDir, "yggdrasil.db-shm");
    await fs.writeFile(dataWalPath, "stale-wal", "utf8");
    await fs.writeFile(dataShmPath, "stale-shm", "utf8");

    await restoreDatabaseFiles(backupDir, dataDir);

    const walExists = await fs.stat(dataWalPath).catch(() => false);
    const shmExists = await fs.stat(dataShmPath).catch(() => false);
    expect(walExists).toBe(false);
    expect(shmExists).toBe(false);
  });

  it("does not throw when the backup has no yggdrasil.db (fresh install)", async () => {
    // A fresh install that has never run has no database, so its pre-update
    // backup is empty. Rollback runs precisely when the update failed, and if
    // the restore threw here it would replace the real failure with a copy
    // error and skip the service restart that follows. Verified live: an
    // install with no DB produced "ENOENT: copyfile ... yggdrasil.db" instead
    // of the actual build error.
    await expect(restoreDatabaseFiles(backupDir, dataDir)).resolves.toBeUndefined();
  });

  it("leaves an existing dataDir database untouched when the backup lacks one", async () => {
    // The flip side: a missing backup entry must not delete data that is
    // already on disk. Restoring nothing is correct; removing the live
    // database would be data loss.
    const dataDbPath = path.join(dataDir, "yggdrasil.db");
    await fs.writeFile(dataDbPath, "existing-data-db", "utf8");

    await restoreDatabaseFiles(backupDir, dataDir);

    const dataDbContent = await fs.readFile(dataDbPath, "utf8");
    expect(dataDbContent).toBe("existing-data-db");
  });
});
