import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("log isolation in unit tests", () => {
  it("syslog writes land in the temp dir, not in data/logs/yggdrasil.log", async () => {
    // Import syslog lazily so it picks up the env var set by the setup file.
    const { syslog } = await import("@/lib/observability/log-store");
    const { env } = await import("@/env");

    // The setup file must have set a temp dir (not the default data/logs path).
    expect(env.YGGDRASIL_LOG_DIR).toBeDefined();
    expect(env.YGGDRASIL_LOG_DIR).not.toContain("data/logs");

    const logDir = env.YGGDRASIL_LOG_DIR!;
    const realLogPath = path.resolve(process.cwd(), "data/logs/yggdrasil.log");

    // Record real log size/mtime before the syslog call (may not exist on CI).
    const realStatBefore = fs.existsSync(realLogPath)
      ? fs.statSync(realLogPath)
      : null;

    // Write a uniquely identifiable line.
    syslog("info", "test", "log-isolation-sentinel-from-test");

    // The temp log must exist and contain the sentinel.
    const tempLogPath = path.join(logDir, "yggdrasil.log");
    expect(fs.existsSync(tempLogPath)).toBe(true);
    const tempContent = fs.readFileSync(tempLogPath, "utf8");
    expect(tempContent).toContain("log-isolation-sentinel-from-test");

    // The real log must NOT have been touched.
    if (realStatBefore === null) {
      // It didn't exist before — it must still not exist.
      expect(fs.existsSync(realLogPath)).toBe(false);
    } else {
      // It existed — mtime and size must be byte-for-byte unchanged.
      const realStatAfter = fs.statSync(realLogPath);
      expect(realStatAfter.mtimeMs).toBe(realStatBefore.mtimeMs);
      expect(realStatAfter.size).toBe(realStatBefore.size);
    }
  });
});
