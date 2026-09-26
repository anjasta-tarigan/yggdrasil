import fs from "node:fs/promises";
import path from "node:path";

const DB_COMPANIONS = ["yggdrasil.db", "yggdrasil.db-wal", "yggdrasil.db-shm"];

export async function backupDatabaseFiles(dataDir: string, backupDestDir: string): Promise<string[]> {
  await fs.mkdir(backupDestDir, { recursive: true });
  const copiedFiles: string[] = [];

  for (const filename of DB_COMPANIONS) {
    const src = path.join(dataDir, filename);
    const dest = path.join(backupDestDir, filename);
    try {
      await fs.copyFile(src, dest);
      copiedFiles.push(filename);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  return copiedFiles;
}

export async function restoreDatabaseFiles(backupSourceDir: string, dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });

  for (const filename of DB_COMPANIONS) {
    const src = path.join(backupSourceDir, filename);
    const dest = path.join(dataDir, filename);
    try {
      await fs.copyFile(src, dest);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      // Not present in the backup.
      if (filename === "yggdrasil.db") {
        // Do nothing — and specifically do NOT delete the live database.
        //
        // A fresh install that never ran has no database, so its pre-update
        // backup is empty and there is simply nothing to restore; throwing
        // here would replace the real update failure with a confusing copy
        // error. But an install that HAS a database whose backup lacks it means
        // the backup was incomplete — removing the live file would be data
        // loss. Leave whatever is on disk alone in both cases.
        continue;
      }
      // A stale -wal/-shm beside a restored .db is inconsistent with it, so
      // drop it.
      await fs.rm(dest, { force: true });
    }
  }
}
