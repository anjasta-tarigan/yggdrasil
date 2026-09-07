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
}

export function generateLaunchdPlist(options: LaunchdConfigOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yggdrasil.server</string>
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
  <string>${path.join(options.logsDir, "yggdrasil.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(options.logsDir, "yggdrasil.err.log")}</string>
</dict>
</plist>
`;
}

export class LaunchdManager implements ServiceManager {
  private plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.yggdrasil.server.plist");

  async installService(paths: InstallPaths): Promise<void> {
    const pnpmRes = await runCommand("which", ["pnpm"]);
    const pnpmPath = pnpmRes.code === 0 ? pnpmRes.stdout.trim() : "/usr/local/bin/pnpm";

    const plist = generateLaunchdPlist({
      appDir: paths.appDir,
      logsDir: paths.logsDir,
      pnpmPath,
      homeDir: os.homedir(),
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
