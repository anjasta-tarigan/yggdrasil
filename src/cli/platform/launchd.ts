import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

export interface LaunchdConfigOptions {
  appDir: string;
  logsDir: string;
  pnpmPath: string;
  homeDir: string;
  appSecret: string;
  port: number;
  /** NODE_OPTIONS env var (e.g. --max-old-space-size=4096) baked into the plist. */
  nodeOptions?: string;
}

// The launchd plist is consumed by macOS, which requires POSIX-style paths.
// path.join() is OS-dependent (it emits backslashes on Windows), so join with
// "/" explicitly — otherwise a Windows dev/build host would emit \Users\... that
// launchd cannot parse.
function posixJoin(...parts: string[]): string {
  return parts.join("/");
}

export function generateLaunchdPlist(options: LaunchdConfigOptions): string {
  // Build the EnvironmentVariables dict. macOS launchd does NOT auto-load
  // .env files (unlike systemd's EnvironmentFile), so every env var the
  // server needs at process start must be listed here — including
  // NODE_OPTIONS which Node.js parses before any user code runs.
  const envEntries = [
    `<key>NODE_ENV</key>
    <string>production</string>`,
    `<key>APP_SECRET</key>
    <string>${options.appSecret}</string>`,
    `<key>PORT</key>
    <string>${options.port}</string>`,
  ];
  if (options.nodeOptions) {
    envEntries.push(`<key>NODE_OPTIONS</key>
    <string>${options.nodeOptions}</string>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yggdrasil.server</string>
  <key>EnvironmentVariables</key>
  <dict>
    ${envEntries.join("\n    ")}
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${options.pnpmPath}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${options.appDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${posixJoin(options.logsDir, "yggdrasil.log")}</string>
  <key>StandardErrorPath</key>
  <string>${posixJoin(options.logsDir, "yggdrasil.err.log")}</string>
</dict>
</plist>
`;
}

export class LaunchdManager implements ServiceManager {
  private plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.yggdrasil.server.plist");

  async installService(paths: InstallPaths): Promise<void> {
    const pnpmRes = await runCommand("which", ["pnpm"]);
    const pnpmPath = pnpmRes.code === 0 ? pnpmRes.stdout.trim() : "/usr/local/bin/pnpm";

    // Read APP_SECRET (and any managed key) straight from the canonical .env so
    // the launchd agent inherits exactly what the installer produced — never a
    // stale ambient environment.
    let appSecret = "";
    let nodeOptions = "";
    try {
      const envText = await fs.readFile(paths.envFile, "utf8");
      const match = envText.split("\n").find((l) => l.startsWith("APP_SECRET="));
      appSecret = match ? match.slice("APP_SECRET=".length).trim() : "";
      const nodeOptsMatch = envText.split("\n").find((l) => l.startsWith("NODE_OPTIONS="));
      nodeOptions = nodeOptsMatch ? nodeOptsMatch.slice("NODE_OPTIONS=".length).trim() : "";
    } catch {
      appSecret = "";
    }
    const plist = generateLaunchdPlist({
      appDir: paths.appDir,
      logsDir: paths.logsDir,
      pnpmPath,
      homeDir: os.homedir(),
      appSecret,
      port: 2302,
      nodeOptions: nodeOptions || undefined,
    });

    await fs.mkdir(path.dirname(this.plistPath), { recursive: true });
    await fs.writeFile(this.plistPath, plist, "utf8");

    await runCommand("launchctl", ["load", "-w", this.plistPath]);
  }

  async uninstallService(): Promise<void> {
    await runCommand("launchctl", ["unload", "-w", this.plistPath]);
    await fs.rm(this.plistPath, { force: true });
  }

  async start(): Promise<void> {
    await runCommand("launchctl", ["start", "com.yggdrasil.server"]);
  }

  async stop(): Promise<void> {
    await runCommand("launchctl", ["stop", "com.yggdrasil.server"]);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("launchctl", ["list", "com.yggdrasil.server"]);
    return { active: res.code === 0, details: res.stdout };
  }
}
