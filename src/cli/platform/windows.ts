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
// Returns the `schtasks /Create` argument vector. The script path is wrapped in
// single quotes: PowerShell accepts single-quoted paths, and — critically —
// single quotes survive intact when handed to `schtasks`, so paths containing
// spaces (custom TargetDir) are not split. We invoke `schtasks` directly from
// Node (no `cmd.exe /c` wrapper) so no shell re-parses the quotes. Returning an
// array (rather than a joined string) lets spawn pass each token verbatim.
export function generateWindowsTaskCommand(scriptPath: string): string[] {
  return [
    "/Create",
    "/TN", "Yggdrasil",
    "/SC", "ONLOGON",
    "/TR", `powershell.exe -NoProfile -WindowStyle Hidden -File '${scriptPath}'`,
    "/RL", "LIMITED",
    "/F",
  ];
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

    // Resolve pnpm's absolute path NOW (while the installer's PATH is correct)
    // and embed it in the script. The scheduled task runs in a limited logon
    // session whose PATH may not include pnpm's install dir (corepack/npm
    // shims), so a bare `pnpm` there would fail silently and the service would
    // never start. `where.exe` is the Windows PATH resolver.
    const pnpmPath = (await runCommand("where.exe", ["pnpm"])).stdout.trim().split("\n")[0] || "pnpm";

    // Build the env block that the launched process will inherit. We explicitly
    // set NODE_ENV=production and load the install's .env so the server never
    // boots from a stale or ambient environment:
    //   - Next.js does NOT override an already-set process env var with a .env
    //     value, so a user profile that exports a non-standard NODE_ENV (which
    //     Next warns about) would otherwise win and defeat the app's .env.
    //   - A prior botched install may have left .env without APP_SECRET; here we
    //     force NODE_ENV + APP_SECRET + PORT from the canonical file so the
    //     service always has a valid secret even if the file copy was partial.
    const envBlock = [
      `$env:NODE_ENV = "production"`,
      `Get-Content "${paths.envFile}" -ErrorAction SilentlyContinue | ForEach-Object {`,
      `  if ($_ -and -not $_.StartsWith("#") -and $_.Contains("=")) {`,
      `    $k, $v = $_ -split "=", 2`,
      `    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim())`,
      `  }`,
      `}`,
    ].join("\n");

    const scriptContent = [
      // Source the install's .env FIRST so the managed keys (NODE_ENV, APP_SECRET,
      // PORT) are present regardless of the ambient environment.
      envBlock,
      // -ErrorAction Stop so a failed cd cannot leave the script running in the
      // wrong directory (which previously made `pnpm start` resolve elsewhere).
      `Set-Location "${paths.appDir}" -ErrorAction Stop`,
      // Re-assert production so a non-standard ambient NODE_ENV cannot leak in
      // (Next.js refuses to override an already-set process env var).
      `$env:NODE_ENV = "production"`,
      `$proc = Start-Process "${pnpmPath}" -ArgumentList "start" -RedirectStandardOutput "${logPath}" -RedirectStandardError "${errLogPath}" -PassThru -WindowStyle Hidden`,
      `$proc.Id | Out-File "${paths.pidFile}" -Encoding ascii`,
    ].join("\n");
    await fs.writeFile(psScript, scriptContent, "utf8");
    // Call schtasks directly (no cmd.exe /c wrapper) so no shell re-parses the
    // quotes in the -TR argument — see generateWindowsTaskCommand.
    const res = await runCommand("schtasks", generateWindowsTaskCommand(psScript));
    if (res.code !== 0) {
      throw new Error(`Failed to create scheduled task: ${res.stderr || res.stdout}`);
    }
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
    // Primary signal: the pidfile written by start-background.ps1, checked for
    // real liveness via tasklist. The PID is language-independent, so this is
    // robust on non-English Windows where `schtasks /Query` localizes
    // "Running" (the old string-match would miss it and let `start()` spawn a
    // duplicate `next start` on port 2302).
    const pid = await readServicePid(resolveInstallPaths().pidFile);
    if (pid !== null) {
      const probe = await runCommand("tasklist", ["/FI", `PID eq ${pid}`]);
      const alive = probe.stdout.includes(String(pid));
      return { active: alive, details: alive ? `pid ${pid} running` : "pidfile stale" };
    }

    // Fallback: no pidfile yet (e.g. a task registered but never run, or a
    // pre-pidfile install). Ask schtasks whether the task is currently running.
    // Accept the localized "Running" substring defensively.
    const res = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST"]);
    const active = /Running/i.test(res.stdout);
    return { active, details: res.stdout };
  }
}
