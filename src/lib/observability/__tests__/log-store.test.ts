import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";

// Point the log store at a temp dir BEFORE the module evaluates. No
// imports are available inside vi.hoisted, so build the path by hand;
// the log store creates the directory itself.
const testLogDir = vi.hoisted(() => {
  const dir = `/tmp/yggdrasil-logs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.YGGDRASIL_LOG_DIR = dir;
  return dir;
});

import {
  syslog,
  queryLogs,
  clearLogs,
  logsAsText,
  logFilePath,
} from "../log-store";

describe("System log store", () => {
  beforeEach(() => {
    clearLogs();
  });

  it("records entries and returns them newest-last", () => {
    syslog("info", "queue", "job started");
    syslog("warn", "daemon", "something slow");
    syslog("error", "queue", "job failed");

    const entries = queryLogs();
    expect(entries.length).toBe(3);
    expect(entries[0].message).toBe("job started");
    expect(entries[2].level).toBe("error");
    expect(entries[0].id).toBeLessThan(entries[2].id);
    expect(entries[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("filters by minimum level and search text", () => {
    syslog("debug", "queue", "deferred job");
    syslog("info", "bootstrap", "system ready");
    syslog("error", "queue", "handler exploded");

    expect(queryLogs({ minLevel: "warn" }).length).toBe(1);
    expect(queryLogs({ minLevel: "info" }).length).toBe(2);

    const queueOnly = queryLogs({ search: "queue" });
    expect(queueOnly.length).toBe(2);
    const exploded = queryLogs({ search: "EXPLODED" });
    expect(exploded.length).toBe(1);
    expect(exploded[0].level).toBe("error");
  });

  it("respects the limit, keeping the most recent entries", () => {
    for (let i = 0; i < 10; i++) syslog("info", "test", `entry ${i}`);
    const entries = queryLogs({ limit: 3 });
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.message)).toEqual([
      "entry 7",
      "entry 8",
      "entry 9",
    ]);
  });

  it("mirrors entries to the log file and clears both on demand", () => {
    syslog("info", "queue", "persisted line");

    const file = logFilePath();
    expect(file.startsWith(testLogDir)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("[INFO] [queue] persisted line");

    const cleared = clearLogs();
    expect(cleared).toBe(1);
    expect(queryLogs().length).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("strips ANSI escape codes from logged messages and scopes", () => {
    syslog("info", "\x1b[36mqueue\x1b[39m", "\x1b[32m\x1b[1m✓\x1b[22m\x1b[39m Compiled in 1307ms");
    const entries = queryLogs();
    expect(entries[0].scope).toBe("queue");
    expect(entries[0].message).toBe("✓ Compiled in 1307ms");
  });
});
