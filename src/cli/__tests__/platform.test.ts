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
