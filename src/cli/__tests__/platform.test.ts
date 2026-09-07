// src/cli/__tests__/platform.test.ts
import { describe, it, expect } from "vitest";
import { generateSystemdUnit } from "../platform/systemd";
import { generateLaunchdPlist } from "../platform/launchd";
import { generateWindowsTaskCommand } from "../platform/windows";

describe("Platform Service Configurations", () => {
  it("generates systemd unit with exact pnpm path and no guessed PATH fallbacks", () => {
    const unit = generateSystemdUnit({
      appDir: "/home/test/.yggdrasil/app",
      envFile: "/home/test/.yggdrasil/.env",
      logsDir: "/home/test/.yggdrasil/data/logs",
      pnpmPath: "/home/test/.local/share/pnpm/pnpm",
      nodeBinDir: "/usr/local/bin",
      pnpmBinDir: "/home/test/.local/share/pnpm",
    });

    expect(unit).toContain("ExecStart=/home/test/.local/share/pnpm/pnpm start");
    expect(unit).toContain("WorkingDirectory=%h/.yggdrasil/app");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("EnvironmentFile=%h/.yggdrasil/.env");
    expect(unit).toContain("PATH=/usr/local/bin:/home/test/.local/share/pnpm");
  });

  it("generates launchd plist with SuccessfulExit=false and no literal tilde", () => {
    const plist = generateLaunchdPlist({
      appDir: "/Users/test/.yggdrasil/app",
      logsDir: "/Users/test/.yggdrasil/data/logs",
      pnpmPath: "/opt/homebrew/bin/pnpm",
      homeDir: "/Users/test",
    });

    expect(plist).not.toContain("~");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<string>/opt/homebrew/bin/pnpm</string>");
    expect(plist).toContain("<string>/Users/test/.yggdrasil/data/logs/yggdrasil.log</string>");
  });

  it("generates Windows schtasks command with %USERPROFILE% and /RL LIMITED", () => {
    const cmd = generateWindowsTaskCommand();
    expect(cmd).toContain("schtasks /Create /TN \"Yggdrasil\"");
    expect(cmd).toContain("/SC ONLOGON");
    expect(cmd).toContain("/RL LIMITED");
    expect(cmd).toContain("%USERPROFILE%\\.yggdrasil\\bin\\start-background.ps1");
  });
});
