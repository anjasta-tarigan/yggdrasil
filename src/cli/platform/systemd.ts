import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

export interface SystemdConfigOptions {
  appDir: string;
  envFile: string;
  logsDir: string;
  pnpmPath: string;
  nodeBinDir: string;
  pnpmBinDir: string;
}

export function generateSystemdUnit(options: SystemdConfigOptions): string {
  return `[Unit]
Description=Yggdrasil Personal AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.yggdrasil/app
EnvironmentFile=%h/.yggdrasil/.env
Environment=PATH=${options.nodeBinDir}:${options.pnpmBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${options.pnpmPath} start
Restart=always
RestartSec=5s
StandardOutput=append:%h/.yggdrasil/data/logs/yggdrasil.log
StandardError=append:%h/.yggdrasil/data/logs/yggdrasil.err.log

[Install]
WantedBy=default.target
`;
}

export class SystemdManager implements ServiceManager {
  private unitPath = path.join(os.homedir(), ".config", "systemd", "user", "yggdrasil.service");

  async installService(paths: InstallPaths): Promise<void> {
    // Enable lingering
    const username = os.userInfo().username;
    await runCommand("loginctl", ["enable-linger", username]);

    const pnpmRes = await runCommand("which", ["pnpm"]);
    const pnpmPath = pnpmRes.code === 0 ? pnpmRes.stdout.trim() : "/usr/local/bin/pnpm";
    const pnpmBinDir = path.dirname(pnpmPath);
    const nodeBinDir = path.dirname(process.execPath);

    const unit = generateSystemdUnit({
      appDir: paths.appDir,
      envFile: paths.envFile,
      logsDir: paths.logsDir,
      pnpmPath,
      nodeBinDir,
      pnpmBinDir,
    });

    await fs.mkdir(path.dirname(this.unitPath), { recursive: true });
    await fs.writeFile(this.unitPath, unit, "utf8");

    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", "yggdrasil"]);
  }

  async uninstallService(): Promise<void> {
    await runCommand("systemctl", ["--user", "stop", "yggdrasil"]);
    await runCommand("systemctl", ["--user", "disable", "yggdrasil"]);
    await fs.rm(this.unitPath, { force: true });
    await runCommand("systemctl", ["--user", "daemon-reload"]);
  }

  async start(): Promise<void> {
    await runCommand("systemctl", ["--user", "start", "yggdrasil"]);
  }

  async stop(): Promise<void> {
    await runCommand("systemctl", ["--user", "stop", "yggdrasil"]);
  }

  async restart(): Promise<void> {
    await runCommand("systemctl", ["--user", "restart", "yggdrasil"]);
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("systemctl", ["--user", "is-active", "yggdrasil"]);
    const active = res.stdout.trim() === "active";
    return { active, details: res.stdout.trim() };
  }
}
