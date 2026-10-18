import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";
import { resolveInstallPaths } from "../utils/paths";
import { waitForProcessExit } from "../utils/health";

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

/** Parse the pid file written by start-background.ps1 (`<pid>\n`, ascii). */
export function parsePidFile(content: string): number | null {
  const n = parseInt(content.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Args for a forced, tree-wide kill of a service PID. */
export function buildTaskKillArgs(pid: number): string[] {
  return ["/PID", String(pid), "/T", "/F"];
}

/** Idempotency decision: only start when not already active. */
export function shouldStartProcess(active: boolean): boolean {
  return !active;
}

/** Read + parse the pid file; null on missing/unreadable (no throw). */
export async function readServicePid(pidFile: string): Promise<number | null> {
  try {
    const content = await fs.readFile(pidFile, "utf8");
    return parsePidFile(content);
  } catch {
    return null; // ENOENT or unreadable → treat as "no live process"
  }
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

  async uninstallService(paths?: InstallPaths): Promise<void> {
    const resolved = paths ?? resolveInstallPaths();
    // Kill the live pnpm→node tree the task spawned before deleting the task,
    // so no orphan survives the uninstall. `runCommand` never throws, so a
    // missing taskkill or already-dead PID is tolerated.
    const pid = await readServicePid(resolved.pidFile);
    if (pid !== null) {
      await runCommand("taskkill", buildTaskKillArgs(pid));
    }
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
    await runCommand("schtasks", ["/Delete", "/TN", "Yggdrasil", "/F"]);
  }

  async start(): Promise<void> {
    // Idempotent: never spawn a second instance. A bare `schtasks /Run` on an
    // already-running task silently launches a duplicate `pnpm start` → a second
    // `next start` on port 2302 and a resource conflict.
    const { active } = await this.status();
    if (!shouldStartProcess(active)) return;
    await runCommand("schtasks", ["/Run", "/TN", "Yggdrasil"]);
  }

  async stop(paths?: InstallPaths): Promise<void> {
    const resolved = paths ?? resolveInstallPaths();
    const pid = await readServicePid(resolved.pidFile);
    if (pid !== null) {
      // /T walks the whole process tree (pnpm → node child) and frees port 2302,
      // which is what prevents the duplicate-conflict after a restart.
      await runCommand("taskkill", buildTaskKillArgs(pid));
      await waitForProcessExit(pid, 10000).catch(() => {});
    }
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
  }

  async restart(paths?: InstallPaths): Promise<void> {
    await this.stop(paths);
    await this.start();
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST"]);
    const active = res.stdout.includes("Running");
    return { active, details: res.stdout };
  }
}
