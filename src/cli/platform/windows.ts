import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

/**
 * Builds the `schtasks /Create` invocation. `scriptPath` must be the absolute
 * path to `start-background.ps1` for *this* install: schtasks stores that path
 * verbatim, so a custom base directory must reach it. The previous version
 * hardcoded `%USERPROFILE%\.yggdrasil`, which pointed the task at the default
 * directory and silently skipped installs made anywhere else.
 */
export function generateWindowsTaskCommand(scriptPath: string): string {
  return `schtasks /Create /TN "Yggdrasil" /SC ONLOGON /TR "powershell.exe -NoProfile -WindowStyle Hidden -File \\"${scriptPath}\\"" /RL LIMITED /F`;
}

export class WindowsManager implements ServiceManager {
  async installService(paths: InstallPaths): Promise<void> {
    await fs.mkdir(paths.binDir, { recursive: true });
    const psScript = path.join(paths.binDir, "start-background.ps1");
    // Absolute paths only: schtasks launches this script at logon from an
    // arbitrary CWD (typically system32), so the old `Set-Location
    // $env:USERPROFILE\.yggdrasil\app` plus relative `..\data\logs` redirects
    // resolved outside the install and `Start-Process` threw before pnpm
    // started. Derive every path from the resolved install paths, mirroring
    // the systemd/launchd managers.
    const logPath = path.join(paths.logsDir, "yggdrasil.log");
    const errLogPath = path.join(paths.logsDir, "yggdrasil.err.log");
    const scriptContent = [
      `Set-Location "${paths.appDir}"`,
      `$proc = Start-Process pnpm -ArgumentList "start" -RedirectStandardOutput "${logPath}" -RedirectStandardError "${errLogPath}" -PassThru -WindowStyle Hidden`,
      `$proc.Id | Out-File "${paths.pidFile}" -Encoding ascii`,
    ].join("\n");
    await fs.writeFile(psScript, scriptContent, "utf8");
    await runCommand("cmd.exe", ["/c", generateWindowsTaskCommand(psScript)]);
  }

  async uninstallService(): Promise<void> {
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
    await runCommand("schtasks", ["/Delete", "/TN", "Yggdrasil", "/F"]);
  }

  async start(): Promise<void> {
    await runCommand("schtasks", ["/Run", "/TN", "Yggdrasil"]);
  }

  async stop(): Promise<void> {
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST"]);
    const active = res.stdout.includes("Running");
    return { active, details: res.stdout };
  }
}
