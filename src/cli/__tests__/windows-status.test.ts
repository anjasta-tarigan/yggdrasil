import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Mock the command runner so lifecycle tests never touch real schtasks/tasklist.
vi.mock("../utils/exec", () => ({ runCommand: vi.fn() }));

import { runCommand } from "../utils/exec";
import { WindowsManager } from "../platform/windows";
import { resolveInstallPaths } from "../utils/paths";

const run = vi.mocked(runCommand);
const mgr = new WindowsManager();
const base = resolveInstallPaths();

describe("Windows service lifecycle — status liveness", () => {
  beforeEach(() => run.mockReset());

  it("status() reports active from a live pidfile via tasklist (locale-independent)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-status-"));
    const pidFile = path.join(dir, "yggdrasil.pid");
    await fs.writeFile(pidFile, "4242\n", "utf8");
    const target = base.pidFile;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(pidFile, target);
    run.mockImplementation(async (cmd: string) => {
      if (cmd === "tasklist") {
        // CSV is not localized, unlike the table output.
        return { code: 0, stdout: '"yggdrasil.exe","4242","Console","1","120,000 K"\r\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await mgr.status();
    expect(res.active).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(target, { force: true });
  });

  it("status() reports inactive when the PID belongs to an unrelated program", async () => {
    // Regression: the old check was `stdout.includes(String(pid))`, so any
    // recycled PID counted as a live server — and stop()/uninstall() then
    // force-killed whatever program now owned that PID.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-status-"));
    const pidFile = path.join(dir, "yggdrasil.pid");
    await fs.writeFile(pidFile, "4242\n", "utf8");
    run.mockImplementation(async (cmd: string) => {
      if (cmd === "tasklist") {
        return { code: 0, stdout: '"java.exe","4242","Console","1","500,000 K"\r\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await mgr.status({ ...base, pidFile });
    expect(res.active).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("status() reports inactive when the pidfile PID is not alive", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-status-"));
    const pidFile = path.join(dir, "yggdrasil.pid");
    await fs.writeFile(pidFile, "9999\n", "utf8");
    const target = base.pidFile;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(pidFile, target);
    run.mockImplementation(async (cmd: string) => {
      // tasklist returns no matching PID -> process is dead.
      if (cmd === "tasklist") return { code: 0, stdout: "INFO: No tasks are running", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const res = await mgr.status();
    expect(res.active).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(target, { force: true });
  });

  it("status() includes scheduler errors when no task is registered", async () => {
    run.mockResolvedValue({ code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." });
    const res = await mgr.status({ ...base, pidFile: path.join(os.tmpdir(), `missing-ygg-${Date.now()}.pid`) });
    expect(res.active).toBe(false);
    expect(res.details).toContain("cannot find the file");
  });
});
