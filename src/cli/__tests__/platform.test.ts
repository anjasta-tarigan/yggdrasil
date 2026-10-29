// src/cli/__tests__/platform.test.ts
import { describe, it, expect } from "vitest";
import { generateSystemdUnit, computeMemoryLimits } from "../platform/systemd";
import { generateLaunchdPlist } from "../platform/launchd";
import { generateWindowsTaskCommand } from "../platform/windows";

describe("Platform Service Configurations", () => {
  it("generates systemd unit with exact pnpm path and no guessed PATH fallbacks", () => {
    const unit = generateSystemdUnit({
      appDir: "/home/test/.yggdrasil/app",
      envFile: "/home/test/.yggdrasil/.env",
      logsDir: "/home/test/.yggdrasil/data/logs",
      pnpmPath: "/home/test/.local/save/pnpm/pnpm",
      nodeBinDir: "/usr/local/bin",
      pnpmBinDir: "/home/test/.local/save/pnpm",
    });

    expect(unit).toContain("ExecStart=/home/test/.local/save/pnpm/pnpm start");
    expect(unit).toContain("WorkingDirectory=%h/.yggdrasil/app");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("EnvironmentFile=%h/.yggdrasil/.env");
    expect(unit).toContain("PATH=/usr/local/bin:/home/test/.local/save/pnpm");
  });

  it("includes default OOMScoreAdjust=-1000, TasksMax=512 when no memory overrides given", () => {
    const unit = generateSystemdUnit({
      appDir: "/home/test/.yggdrasil/app",
      envFile: "/home/test/.yggdrasil/.env",
      logsDir: "/home/test/.yggdrasil/data/logs",
      pnpmPath: "/home/test/.local/save/pnpm/pnpm",
      nodeBinDir: "/usr/local/bin",
      pnpmBinDir: "/home/test/.local/save/pnpm",
    });

    expect(unit).toContain("OOMScoreAdjust=-1000");
    expect(unit).toContain("TasksMax=512");
  });

  it("generates systemd unit with explicit MemoryHigh, MemoryMax, OOMScoreAdjust, and TasksMax", () => {
    const unit = generateSystemdUnit({
      appDir: "/home/test/.yggdrasil/app",
      envFile: "/home/test/.yggdrasil/.env",
      logsDir: "/home/test/.yggdrasil/data/logs",
      pnpmPath: "/home/test/.local/save/pnpm/pnpm",
      nodeBinDir: "/usr/local/bin",
      pnpmBinDir: "/home/test/.local/save/pnpm",
      memoryMaxBytes: 8 * 1024 * 1024 * 1024, // 8G
      memoryHighBytes: 6 * 1024 * 1024 * 1024, // 6G
      oomScoreAdjust: -1000,
      tasksMax: 512,
    });

    expect(unit).toContain("MemoryMax=8G");
    expect(unit).toContain("MemoryHigh=6G");
    expect(unit).toContain("OOMScoreAdjust=-1000");
    expect(unit).toContain("TasksMax=512");
  });

  it("omits MemoryHigh/MemoryMax when set to 0, but keeps OOMScoreAdjust and TasksMax", () => {
    const unit = generateSystemdUnit({
      appDir: "/home/test/.yggdrasil/app",
      envFile: "/home/test/.yggdrasil/.env",
      logsDir: "/home/test/.yggdrasil/data/logs",
      pnpmPath: "/home/test/.local/save/pnpm/pnpm",
      nodeBinDir: "/usr/local/bin",
      pnpmBinDir: "/home/test/.local/save/pnpm",
      memoryMaxBytes: 0,
      memoryHighBytes: 0,
      oomScoreAdjust: -500,
    });

    expect(unit).not.toContain("MemoryMax=");
    expect(unit).not.toContain("MemoryHigh=");
    expect(unit).toContain("OOMScoreAdjust=-500");
    expect(unit).toContain("TasksMax=512");
  });

  it("formats memory specifiers with decimal GB when fractional", () => {
    const unit = generateSystemdUnit({
      appDir: "/h/app",
      envFile: "/h/.env",
      logsDir: "/h/logs",
      pnpmPath: "/p/pnpm",
      nodeBinDir: "/n",
      pnpmBinDir: "/p",
      // 6.5 GB exactly → 6.5G, 2.5 GB → 2.5G
      memoryMaxBytes: 6_962_633_728,
      memoryHighBytes: 2_684_354_560,
    });

    expect(unit).toContain("MemoryMax=6.5G");
    expect(unit).toContain("MemoryHigh=2.5G");
  });

  it("formats integer GB values without decimals", () => {
    const unit = generateSystemdUnit({
      appDir: "/h/app",
      envFile: "/h/.env",
      logsDir: "/h/logs",
      pnpmPath: "/p/pnpm",
      nodeBinDir: "/n",
      pnpmBinDir: "/p",
      memoryMaxBytes: 8 * 1024 ** 3, // 8G
      memoryHighBytes: 6 * 1024 ** 3, // 6G
    });

    expect(unit).toContain("MemoryMax=8G");
    expect(unit).toContain("MemoryHigh=6G");
  });

  it("formats sub-GB values in MB", () => {
    const unit = generateSystemdUnit({
      appDir: "/h/app",
      envFile: "/h/.env",
      logsDir: "/h/logs",
      pnpmPath: "/p/pnpm",
      nodeBinDir: "/n",
      pnpmBinDir: "/p",
      memoryMaxBytes: 512 * 1024 * 1024, // 512M
      memoryHighBytes: 256 * 1024 * 1024, // 256M
    });

    expect(unit).toContain("MemoryMax=512M");
    expect(unit).toContain("MemoryHigh=256M");
  });

  it("computeMemoryLimits defaults to 60% high and 80% max of total memory", () => {
    const { memoryHigh, memoryMax } = computeMemoryLimits(16 * 1024 ** 3);
    expect(memoryHigh).toBe(Math.round(16 * 1024 ** 3 * 0.60));
    expect(memoryMax).toBe(Math.round(16 * 1024 ** 3 * 0.80));
  });

  it("computeMemoryLimits respects env overrides", () => {
    const { memoryHigh, memoryMax } = computeMemoryLimits(16 * 1024 ** 3, {
      YGGDRASIL_MEMORY_HIGH_BYTES: "4294967296",
      YGGDRASIL_MEMORY_MAX_BYTES: "6442450944",
    });
    expect(memoryHigh).toBe(4294967296);
    expect(memoryMax).toBe(6442450944);
  });

  it("generates launchd plist with SuccessfulExit=false and no literal tilde", () => {
    const plist = generateLaunchdPlist({
      appDir: "/Users/test/.yggdrasil/app",
      logsDir: "/Users/test/.yggdrasil/data/logs",
      pnpmPath: "/opt/homebrew/bin/pnpm",
      homeDir: "/Users/test",
      appSecret: "a".repeat(64),
      port: 2302,
    });

    expect(plist).not.toContain("~");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<string>/opt/homebrew/bin/pnpm</string>");
    expect(plist).toContain("<string>/Users/test/.yggdrasil/data/logs/yggdrasil.log</string>");
    // The launchd agent must force a production environment so a stale ambient
    // NODE_ENV (or a missing APP_SECRET) can never reach the server.
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>NODE_ENV</key>");
    expect(plist).toContain("<string>production</string>");
    expect(plist).toContain("<key>APP_SECRET</key>");
    expect(plist).toContain("<key>PORT</key>");
  });

  it("generates launchd plist with NODE_OPTIONS when nodeOptions provided", () => {
    const plist = generateLaunchdPlist({
      appDir: "/Users/test/.yggdrasil/app",
      logsDir: "/Users/test/.yggdrasil/data/logs",
      pnpmPath: "/opt/homebrew/bin/pnpm",
      homeDir: "/Users/test",
      appSecret: "a".repeat(64),
      port: 2302,
      nodeOptions: "--max-old-space-size=4096",
    });

    expect(plist).toContain("<key>NODE_OPTIONS</key>");
    expect(plist).toContain("<string>--max-old-space-size=4096</string>");
  });

  it("generates launchd plist without NODE_OPTIONS when not provided", () => {
    const plist = generateLaunchdPlist({
      appDir: "/Users/test/.yggdrasil/app",
      logsDir: "/Users/test/.yggdrasil/data/logs",
      pnpmPath: "/opt/homebrew/bin/pnpm",
      homeDir: "/Users/test",
      appSecret: "a".repeat(64),
      port: 2302,
    });

    expect(plist).not.toContain("NODE_OPTIONS");
  });

  it("generates Windows schtasks command pointing at the resolved script path", () => {
    const scriptPath = "C:\\Users\\test\\custom-ygg\\bin\\start-background.ps1";
    // The builder returns an argv array (passed verbatim to spawn), so the
    // script path is NOT re-parsed by a shell — this is what keeps paths with
    // spaces (custom TargetDir) intact.
    const argv = generateWindowsTaskCommand(scriptPath);
    // The builder returns an argv array (passed verbatim to spawn), so the
    // script path is NOT re-parsed by a shell — this is what keeps paths with
    // spaces (custom TargetDir) intact. Quotes are shell syntax, not part of
    // the argv tokens, so we assert on the tokens directly.
    expect(argv).toContain("/Create");
    expect(argv).toContain("/TN");
    expect(argv).toContain("Yggdrasil");
    expect(argv).toContain("/SC");
    expect(argv).toContain("ONLOGON");
    expect(argv).toContain("/RL");
    expect(argv).toContain("LIMITED");
    // The -TR token must single-quote the script path so PowerShell accepts it
    // without cmd.exe backslash-escaping mangling spaces.
    expect(argv).toContain(`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File '${scriptPath}'`);
    // The task must reference the resolved install's script, not a hardcoded
    // %USERPROFILE%\.yggdrasil — otherwise custom-directory installs point at a
    // file that never exists.
    expect(argv.join(" ")).toContain(scriptPath);
    expect(argv.join(" ")).not.toContain("%USERPROFILE%");
  });
});
