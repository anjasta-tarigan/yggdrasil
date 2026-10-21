import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  generateWindowsStartupCommand,
  generateWindowsTrayStartupCommand,
  generateWindowsTrayProcessCommand,
  generateWindowsTrayStopCommand,
  generateWindowsTaskCommand,
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

  it("encodes startup launch commands so Windows paths are not reparsed", () => {
    const scriptPath = "C:\\Users\\O'Brien\\.yggdrasil\\bin\\start-background.ps1";
    const command = generateWindowsStartupCommand(scriptPath);
    expect(command).toMatch(/^@echo off\r\nstart "" powershell\.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/]+=*\r\n$/);
    const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/]+=*)/)?.[1];
    expect(Buffer.from(encoded!, "base64").toString("utf16le")).toContain("O''Brien");
    expect(generateWindowsTaskCommand(scriptPath)).toContain(
      "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File 'C:\\Users\\O''Brien\\.yggdrasil\\bin\\start-background.ps1'",
    );
  });

  it("encodes a tray launcher for the installed app and install directory", () => {
    const scriptPath = "C:\\Users\\O'Brien\\.yggdrasil\\app\\scripts\\yggdrasil-tray.ps1";
    const baseDir = "C:\\Users\\O'Brien\\.yggdrasil";
    const command = generateWindowsTrayStartupCommand(scriptPath, baseDir);
    const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/]+=*)/)?.[1];
    expect(encoded).toBeTruthy();
    const decoded = Buffer.from(encoded!, "base64").toString("utf16le");
    expect(decoded).toContain("O''Brien");
    expect(decoded).toContain("yggdrasil-tray.ps1");
    expect(decoded).toContain("-BaseDir");
    const processCommand = generateWindowsTrayProcessCommand(scriptPath, baseDir);
    const launch = Buffer.from(processCommand, "base64").toString("utf16le");
    const childEncoded = launch.match(/-EncodedCommand','([A-Za-z0-9+/]+=*)/)?.[1];
    expect(childEncoded).toBeTruthy();
    expect(Buffer.from(childEncoded!, "base64").toString("utf16le")).toContain("-BaseDir");
    expect(Buffer.from(generateWindowsTrayStopCommand(), "base64").toString("utf16le")).toContain(
      "YggdrasilTrayStop"
    );
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
  const mgr = new WindowsManager();

  beforeEach(() => {
    run.mockReset();
  });

  it("registers the tray app in the Startup folder for the selected install", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-tray-startup-"));
    const previousAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    const paths = resolveInstallPaths(path.join(dir, "install"));
    try {
      await fs.mkdir(path.join(paths.appDir, "scripts"), { recursive: true });
      await fs.writeFile(path.join(paths.appDir, "scripts", "yggdrasil-tray.ps1"), "tray script");
      await mgr.installTrayLauncher(paths);
      const launcher = path.join(dir, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Yggdrasil Tray.cmd");
      const content = await fs.readFile(launcher, "utf8");
      expect(content).toContain("-EncodedCommand");
      expect(await fs.readFile(path.join(paths.binDir, "yggdrasil-tray.ps1"), "utf8")).toBe("tray script");
      const encoded = content.match(/-EncodedCommand ([A-Za-z0-9+/]+=*)/)?.[1];
      expect(Buffer.from(encoded!, "base64").toString("utf16le")).toContain(
        path.join(paths.binDir, "yggdrasil-tray.ps1").replace(/'/g, "''")
      );
      await mgr.uninstallService(paths);
      await expect(fs.access(launcher)).rejects.toThrow();
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("start() is a no-op when the service is already running (no duplicate spawn)", async () => {
    const paths = { ...resolveInstallPaths(), pidFile: path.join(os.tmpdir(), `ygg-noop-${Date.now()}.pid`) };
    mockStatus(true);
    await mgr.start(paths);
    expect(calledWith("schtasks", "/Run")).toBe(false);
  });

  it("start() runs the task when inactive", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-start-task-"));
    const previousAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    try {
      mockStatus(false);
      await mgr.start();
      expect(calledWith("schtasks", "/Run")).toBe(true);
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the current user's Startup folder when Task Scheduler denies registration", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-startup-"));
    const previousAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    const paths = resolveInstallPaths(path.join(dir, "A$B O'Brien", "install"));
    run.mockImplementation(async (cmd: string) => {
      if (cmd === "where.exe") return { code: 0, stdout: "C:\\Users\\test\\pnpm\r\nC:\\Users\\test\\pnpm.cmd\r\n", stderr: "" };
      if (cmd === "powershell.exe") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "ERROR: Access is denied." };
    });

    try {
      await expect(mgr.installService(paths)).resolves.toBe("startup-folder");
      const launcher = path.join(dir, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Yggdrasil.cmd");
      expect(await fs.readFile(launcher, "utf8")).toContain("-EncodedCommand");
      const startScript = await fs.readFile(path.join(paths.binDir, "start-background.ps1"), "utf8");
      expect(startScript).toContain("A$B O''Brien");
      expect(startScript).toContain("$ErrorActionPreference = \"Stop\"");
      expect(startScript).toContain("Start-Process 'C:\\Users\\test\\pnpm.cmd'");
      expect(startScript).not.toContain("pnpm`r'");
      await mgr.start(paths);
      expect(run).toHaveBeenCalledWith(
        "powershell.exe",
        expect.arrayContaining(["-ExecutionPolicy", "Bypass", "-File", path.join(paths.binDir, "start-background.ps1")]),
        { windowsHide: true },
      );
      await mgr.uninstallService(paths);
      await expect(fs.access(launcher)).rejects.toThrow();
    } finally {
      if (previousAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previousAppData;
      await fs.rm(dir, { recursive: true, force: true });
    }
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
