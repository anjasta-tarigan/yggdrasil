import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Unit-test log isolation.
 *
 * `syslog()` in `src/lib/observability/log-store.ts` mirrors every log entry
 * to `LOG_DIR/yggdrasil.log`, where `LOG_DIR` is resolved at module-load time
 * from `env.YGGDRASIL_LOG_DIR` (which in turn reads `process.env` at its own
 * module-load time). Setting the env var here — in a vitest setup file that
 * runs before any test file is imported — ensures the log store writes to a
 * fresh temp directory instead of `data/logs/yggdrasil.log`.
 *
 * Uses `mkdtempSync` so the env var is set synchronously before any async
 * module resolution can race against it.
 *
 * The integration project is intentionally NOT given this setup file.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), "ygg-log-"));

process.env.YGGDRASIL_LOG_DIR = dir;

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
    console.warn(
      `[setup-isolated-log-dir] Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`
    );
  });
});
