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
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (filename === "yggdrasil.db") {
          throw err;
        }
        // If the backup didn't have a -wal or -shm, remove any stale one in dataDir
        await fs.rm(dest, { force: true });
      } else {
        throw err;
      }
    }
  }
}
