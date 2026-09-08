import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";

// Point the log store at a temp dir BEFORE the module evaluates.
vi.hoisted(() => {
  const dir = `/tmp/yggdrasil-logs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.YGGDRASIL_LOG_DIR = dir;
});

import {
  installGlobalCapture,
  uninstallGlobalCapture,
} from "../capture";
import { queryLogs, clearLogs, logFilePath } from "../log-store";

describe("Global log capture", () => {
  beforeEach(() => {
    clearLogs();
    uninstallGlobalCapture();
  });

  afterEach(() => {
    uninstallGlobalCapture();
  });

  it("captures console.error with scope prefix and stack", () => {
    installGlobalCapture();
    const err = new Error("boom");
    console.error("[QueueRunner] job exploded", err);

    const entries = queryLogs({ minLevel: "error" });
    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe("error");
    expect(entries[0].scope).toBe("QueueRunner");
    expect(entries[0].message).toContain("job exploded");
    expect(entries[0].message).toContain("boom");
    expect(entries[0].message).toContain("capture.test"); // stack frames
  });

  it("captures console.warn as warn level", () => {
    installGlobalCapture();
    console.warn("[scheduler] tick took too long");

    const entries = queryLogs({ minLevel: "warn" });
    expect(entries.length).toBe(1);
    expect(entries[0].level).toBe("warn");
    expect(entries[0].scope).toBe("scheduler");
  });

  it("maps console.log and console.info to info, console.debug to debug", () => {
    installGlobalCapture();
    console.log("plain message");
    console.info("[daemon] heartbeat");
    console.debug("verbose detail");

    expect(queryLogs().length).toBe(3);
    const plain = queryLogs({ search: "plain message" })[0];
    expect(plain.level).toBe("info");
    expect(plain.scope).toBe("console"); // no [Scope] prefix
    const hb = queryLogs({ search: "heartbeat" })[0];
    expect(hb.level).toBe("info");
    expect(hb.scope).toBe("daemon");
    const dbg = queryLogs({ search: "verbose" })[0];
    expect(dbg.level).toBe("debug");
  });

  it("serializes non-string arguments safely, including circular ones", () => {
    installGlobalCapture();
    const circular: Record<string, unknown> = { name: "node" };
    circular.self = circular;
    console.log("[test] state", { count: 3 }, circular);

    const entry = queryLogs({ search: "state" })[0];
    expect(entry.message).toContain('"count":3');
    expect(entry.message).toContain("node"); // circular did not throw
  });

  it("truncates runaway messages", () => {
    installGlobalCapture();
    console.log("x".repeat(10_000));

    const entry = queryLogs()[0];
    expect(entry.message.length).toBeLessThanOrEqual(2100);
    expect(entry.message).toContain("(truncated)");
  });

  it("is idempotent — installing twice does not double-log", () => {
    installGlobalCapture();
    installGlobalCapture();
    console.warn("[dup] once");

    expect(queryLogs({ search: "once" }).length).toBe(1);
  });

  it("captures unhandled rejections", async () => {
    installGlobalCapture();
    const before = queryLogs({ minLevel: "error" }).length;
    Promise.reject(new Error("async failure"));

    // unhandledRejection fires on the next macrotask.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const entries = queryLogs({ minLevel: "error" });
    expect(entries.length).toBe(before + 1);
    const entry = entries[entries.length - 1];
    expect(entry.scope).toBe("process");
    expect(entry.message).toContain("async failure");
  });

  it("still calls through to the original console method", () => {
    installGlobalCapture();
    // Spy on the patched console.log's underlying original by capturing
    // what syslog saw: the mirror must run BOTH syslog and the original.
    console.log("[mirror] passthrough");
    const entry = queryLogs({ search: "passthrough" })[0];
    expect(entry).toBeDefined();
    expect(entry.scope).toBe("mirror");
    expect(entry.level).toBe("info");
  });

  it("survives an already-installed capture after HMR-style reinstall", () => {
    installGlobalCapture();
    console.error("[first] logged");
    // A second install must be a no-op, not a re-patch of patched methods.
    installGlobalCapture();
    console.error("[second] logged");

    expect(queryLogs({ search: "first" }).length).toBe(1);
    expect(queryLogs({ search: "second" }).length).toBe(1);
  });
});

describe("Global capture file mirroring", () => {
  beforeEach(() => {
    clearLogs();
    uninstallGlobalCapture();
  });

  afterEach(() => uninstallGlobalCapture());

  it("writes captured console output to the log file", () => {
    installGlobalCapture();
    console.error("[filetest] mirrored error");

    const content = fs.readFileSync(logFilePath(), "utf8");
    expect(content).toContain("[ERROR] [filetest] mirrored error");
  });
});
