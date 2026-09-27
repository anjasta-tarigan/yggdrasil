import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression: importing `@/db` must not open (or migrate) the SQLite file.
 *
 * The client used to be created and migrated at module-evaluation time, so
 * every `next build` page-data worker that imported any route reaching `@/db`
 * opened and mutated the live production database — and parallel workers raced
 * on the additive migrations, aborting the build with
 * `SqliteError: duplicate column name: …`. Opening is now deferred to first use.
 */
describe("db module import is side-effect free", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.resetModules();
    delete process.env.DATABASE_PATH;
  });

  it("does not create the database file on import, but does on first use", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ygg-db-lazy-"));
    tmpDirs.push(dir);
    const dbPath = path.join(dir, "nested", "yggdrasil.db");
    process.env.DATABASE_PATH = dbPath;

    vi.resetModules();
    const mod = await import("@/db");

    // Import alone must not touch the filesystem.
    expect(fs.existsSync(dbPath)).toBe(false);

    // First use opens the database and runs the migrations.
    const row = mod.sqlite.prepare("SELECT 1 AS n").get() as { n: number };
    expect(row.n).toBe(1);
    expect(fs.existsSync(dbPath)).toBe(true);

    mod.sqlite.close();
  });
});
