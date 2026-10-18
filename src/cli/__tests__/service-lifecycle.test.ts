import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mock the command runner and the process-exit waiter so lifecycle tests never
// touch real schtasks/taskkill or sleep on a (possibly) live PID.
vi.mock("../utils/exec", () => ({ runCommand: vi.fn() }));
vi.mock("../utils/health", () => ({
  waitForProcessExit: vi.fn(async () => true),
  waitForHealth: vi.fn(async () => true),
}));

import { runCommand } from "../utils/exec";
import {
  WindowsManager,
  parsePidFile,
  buildTaskKillArgs,
  shouldStartProcess,
  readServicePid,
} from "../platform/windows";
import { resolveInstallPaths } from "../utils/paths";

const run = vi.mocked(runCommand);

/** Drives the mocked `runCommand`: /Query reports active per `running`. */
function mockStatus(running: boolean) {
  run.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === "schtasks" && args.includes("/Query")) {
      return { code: 0, stdout: running ? "Status: Running" : "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

function calledWith(cmd: string, flag: string): boolean {
  return run.mock.calls.some(([c, a]) => c === cmd && Array.isArray(a) && a.includes(flag));
}

function indexOfCall(cmd: string, flag: string): number {
  return run.mock.calls.findIndex(([c, a]) => c === cmd && Array.isArray(a) && a.includes(flag));
}

describe("Windows service lifecycle — pure helpers", () => {
  it("parsePidFile parses a numeric PID and rejects junk", () => {
    expect(parsePidFile("12345\n")).toBe(12345);
    expect(parsePidFile("  987 \n")).toBe(987);
    expect(parsePidFile("")).toBeNull();
    expect(parsePidFile("   ")).toBeNull();
    expect(parsePidFile("abc")).toBeNull();
    expect(parsePidFile("0")).toBeNull();
    expect(parsePidFile("-5")).toBeNull();
    expect(parsePidFile("12\n34")).toBe(12);
  });

  it("buildTaskKillArgs builds a forced tree-wide kill", () => {
    expect(buildTaskKillArgs(4321)).toEqual(["/PID", "4321", "/T", "/F"]);
  });

  it("shouldStartProcess is false only when already active", () => {
    expect(shouldStartProcess(true)).toBe(false);
    expect(shouldStartProcess(false)).toBe(true);
  });

  it("readServicePid reads a real pid file and returns null when missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-pid-"));
    const pidFile = path.join(dir, "yggdrasil.pid");
    await fs.writeFile(pidFile, "24680\n", "utf8");
    expect(await readServicePid(pidFile)).toBe(24680);
    expect(await readServicePid(path.join(dir, "absent.pid"))).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("Windows service lifecycle — manager behavior", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, "../../../");
  const mgr = new WindowsManager();

  beforeEach(() => {
    run.mockReset();
  });

  it("start() is a no-op when the service is already running (no duplicate spawn)", async () => {
    mockStatus(true);
    await mgr.start();
    expect(calledWith("schtasks", "/Run")).toBe(false);
  });

  it("start() runs the task when inactive", async () => {
    mockStatus(false);
    await mgr.start();
    expect(calledWith("schtasks", "/Run")).toBe(true);
  });

  it("stop() kills the pid tree BEFORE ending the task, and never when no pid file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-stop-"));
    const pidFile = path.join(dir, "yggdrasil.pid");
    await fs.writeFile(pidFile, "9876\n", "utf8");
    const paths = { ...resolveInstallPaths(), pidFile };

    mockStatus(true);
    await mgr.stop(paths);

    expect(calledWith("taskkill", "/PID")).toBe(true);
    expect(indexOfCall("taskkill", "/PID")).toBeLessThan(indexOfCall("schtasks", "/End"));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stop() still ends the task when the pid file is missing (no taskkill)", async () => {
    const paths = { ...resolveInstallPaths(), pidFile: path.join(os.tmpdir(), "ygg-missing-" + Date.now() + ".pid") };
    mockStatus(false);
    await mgr.stop(paths);
    expect(calledWith("taskkill", "/PID")).toBe(false);
    expect(calledWith("schtasks", "/End")).toBe(true);
  });

  it("uninstallService() kills the pid tree, ends, then deletes the task", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-un-"));
    const pidFile = path.join(dir, "yggdrasil.pid");
    await fs.writeFile(pidFile, "5555\n", "utf8");
    const paths = { ...resolveInstallPaths(), pidFile };

    mockStatus(true);
    await mgr.uninstallService(paths);

    expect(calledWith("taskkill", "/PID")).toBe(true);
    const taskkillIdx = indexOfCall("taskkill", "/PID");
    expect(indexOfCall("schtasks", "/End")).toBeGreaterThan(taskkillIdx);
    expect(indexOfCall("schtasks", "/Delete")).toBeGreaterThan(taskkillIdx);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("uninstallService() deletes the task even with no pid file", async () => {
    const paths = { ...resolveInstallPaths(), pidFile: path.join(os.tmpdir(), "ygg-un-missing-" + Date.now() + ".pid") };
    mockStatus(false);
    await mgr.uninstallService(paths);
    expect(calledWith("taskkill", "/PID")).toBe(false);
    expect(calledWith("schtasks", "/Delete")).toBe(true);
  });
});
