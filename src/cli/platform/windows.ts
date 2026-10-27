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
    "/TR", `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${quotePowerShell(scriptPath)}`,
    "/RL", "LIMITED",
    "/F",
  ];
}

export function generateWindowsStartupCommand(scriptPath: string): string {
  const psCommand = `& '${scriptPath.replace(/'/g, "''")}'`;
  const encoded = Buffer.from(psCommand, "utf16le").toString("base64");
  return `@echo off\r\nstart "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}\r\n`;
}

export function generateWindowsTrayStartupCommand(scriptPath: string, baseDir: string): string {
  const psCommand = `& '${scriptPath.replace(/'/g, "''")}' -BaseDir '${baseDir.replace(/'/g, "''")}'`;
  const encoded = Buffer.from(psCommand, "utf16le").toString("base64");
  return `@echo off\r\nstart "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}\r\n`;
}

export function generateWindowsTrayProcessCommand(scriptPath: string, baseDir: string): string {
  const psScriptPath = scriptPath.replace(/'/g, "''");
  const psBaseDir = baseDir.replace(/'/g, "''");
  const tray = `& '${psScriptPath}' -BaseDir '${psBaseDir}'`;
  const encodedTray = Buffer.from(tray, "utf16le").toString("base64");
  const launch = `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encodedTray}')`;
  return Buffer.from(launch, "utf16le").toString("base64");
}

export function generateWindowsTrayStopCommand(): string {
  const stop = `try { $e = [Threading.EventWaitHandle]::OpenExisting('Local\\YggdrasilTrayStop'); $e.Set() | Out-Null; $e.Dispose(); $m = [Threading.Mutex]::OpenExisting('Local\\YggdrasilTray'); [void]$m.WaitOne(5000); $m.ReleaseMutex(); $m.Dispose() } catch [System.Threading.WaitHandleCannotBeOpenedException] { } catch [System.Threading.AbandonedMutexException] { }`;
  return Buffer.from(stop, "utf16le").toString("base64");
}

export function windowsStartupLauncherPath(appData = process.env.APPDATA): string {
  if (!appData) throw new Error("APPDATA is unavailable; cannot register a per-user startup launcher");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Yggdrasil.cmd");
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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

/**
 * Image names the Yggdrasil service can legitimately run under: the bundled
 * runtime copy, or plain node in older/installed-by-hand layouts.
 */
const SERVICE_IMAGE_NAMES = new Set(["yggdrasil.exe", "node.exe"]);

/**
 * Extract the image name from `tasklist /FO CSV /NH` output.
 *
 * The previous liveness check was `stdout.includes(String(pid))`, so PID 123
 * matched 1234 and — far worse — a recycled PID belonging to any unrelated
 * program (an editor, a browser) counted as "the service is running" and was
 * then force-killed by `stop`/`uninstall`.
 */
export function parseTasklistImageName(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).find((l) => /^\s*"/.test(l));
  if (!line) return null;
  const m = line.match(/^\s*"([^"]+)"/);
  return m ? m[1].trim() : null;
}

/** True only when the PID's image is one Yggdrasil itself runs as. */
export function isServiceImageName(imageName: string | null): boolean {
  return imageName !== null && SERVICE_IMAGE_NAMES.has(imageName.toLowerCase());
}

/** Ask tasklist for a PID's image name; null when the PID is not running. */
export async function readProcessImageName(pid: number): Promise<string | null> {
  const res = await runCommand("tasklist", [
    "/FI",
    `PID eq ${pid}`,
    "/FO",
    "CSV",
    "/NH",
  ]);
  if (res.code !== 0) return null;
  return parseTasklistImageName(res.stdout);
}

/**
 * Does a registered task point at this install?
 *
 * The task name `Yggdrasil` is global to the user, so a second install (or an
 * uninstall run against a temp `--dir`) must not end or delete the task that
 * belongs to the real one. `schtasks /Query /FO LIST /V` prints the action
 * verbatim, which contains the absolute `start-background.ps1` path. Matching
 * the base directory avoids depending on localized field labels. An empty
 * answer means the query told us nothing, so the historical best-effort
 * behavior is kept.
 */
export function taskBelongsToInstall(queryStdout: string, baseDir: string): boolean {
  const text = queryStdout.trim();
  if (text.length === 0) return true;
  return text.toLowerCase().includes(baseDir.toLowerCase());
}

/**
 * Delete a Startup-folder launcher only when it was written for this install.
 *
 * The launcher stores its target as an `-EncodedCommand` base64 payload; a
 * different install's launcher decodes to a different base directory and is
 * left alone.
 */
async function removeLauncherIfOwned(launcherPath: string, baseDir: string): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(launcherPath, "utf8");
  } catch {
    return; // absent: nothing to remove
  }
  const encoded = content.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1];
  if (encoded) {
    // The payload is PowerShell, where a literal quote is doubled (`O''Brien`).
    // Compare against the unescaped form, or an install under a path with an
    // apostrophe looked like another install's launcher and was left behind.
    const decoded = Buffer.from(encoded, "base64")
      .toString("utf16le")
      .replace(/''/g, "'")
      .toLowerCase();
    if (!decoded.includes(baseDir.toLowerCase())) return;
  }
  await fs.rm(launcherPath, { force: true });
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
  async installTrayLauncher(paths: InstallPaths): Promise<void> {
    const startupLauncher = path.join(
      path.dirname(windowsStartupLauncherPath()),
      "Yggdrasil Tray.cmd"
    );
    const trayScript = path.join(paths.binDir, "yggdrasil-tray.ps1");
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.copyFile(path.join(paths.appDir, "scripts", "yggdrasil-tray.ps1"), trayScript);
    await fs.mkdir(path.dirname(startupLauncher), { recursive: true });
    await fs.writeFile(
      startupLauncher,
      generateWindowsTrayStartupCommand(trayScript, paths.baseDir),
      "utf8"
    );
  }

  async startTray(paths: InstallPaths): Promise<void> {
    if (process.env.VITEST !== undefined) return;
    const trayScript = path.join(paths.binDir, "yggdrasil-tray.ps1");
    const result = await runCommand(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", generateWindowsTrayProcessCommand(trayScript, paths.baseDir)],
      { windowsHide: true }
    );
    if (result.code !== 0) {
      throw new Error(`Could not start the Yggdrasil tray app: ${result.stderr || result.stdout}`);
    }
  }

  async stopTray(): Promise<void> {
    await runCommand(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", generateWindowsTrayStopCommand()],
      { windowsHide: true }
    );
  }

  async installService(paths: InstallPaths, port?: number): Promise<void | "startup-folder"> {
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
    const runtimePath = path.join(paths.binDir, "yggdrasil.exe");
    try {
      await fs.access(runtimePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (path.resolve(process.execPath).toLowerCase() !== path.resolve(runtimePath).toLowerCase()) {
        await fs.copyFile(process.execPath, runtimePath);
      }
    }
    const nextCliPath = path.join(paths.appDir, "node_modules", "next", "dist", "bin", "next");

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
      `Get-Content ${quotePowerShell(paths.envFile)} -ErrorAction SilentlyContinue | ForEach-Object {`,
      `  if ($_ -and -not $_.StartsWith("#") -and $_.Contains("=")) {`,
      `    $k, $v = $_ -split "=", 2`,
      `    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim())`,
      `  }`,
      `}`,
    ].join("\n");

    const scriptContent = [
      `$ErrorActionPreference = "Stop"`,
      // Source the install's .env FIRST so the managed keys (NODE_ENV, APP_SECRET,
      // PORT) are present regardless of the ambient environment.
      envBlock,
      // -ErrorAction Stop so a failed cd cannot leave the script running in the
      // wrong directory (which previously made `pnpm start` resolve elsewhere).
      `Set-Location ${quotePowerShell(paths.appDir)} -ErrorAction Stop`,
      // Re-assert production so a non-standard ambient NODE_ENV cannot leak in
      // (Next.js refuses to override an already-set process env var).
      `$env:NODE_ENV = "production"`,
      `$proc = Start-Process ${quotePowerShell(runtimePath)} -ArgumentList ${quotePowerShell(`"${nextCliPath}" start -H 127.0.0.1${typeof port === "number" ? ` -p ${port}` : ""}`)} -RedirectStandardOutput ${quotePowerShell(logPath)} -RedirectStandardError ${quotePowerShell(errLogPath)} -PassThru -WindowStyle Hidden -ErrorAction Stop`,
      `$proc.Id | Out-File ${quotePowerShell(paths.pidFile)} -Encoding ascii`,
    ].join("\n");
    await fs.writeFile(psScript, scriptContent, "utf8");
    // Call schtasks directly (no cmd.exe /c wrapper) so no shell re-parses the
    // quotes in the -TR argument — see generateWindowsTaskCommand.
    const res = await runCommand("schtasks", generateWindowsTaskCommand(psScript));
    if (res.code !== 0) {
      const startupLauncher = windowsStartupLauncherPath();
      await fs.mkdir(path.dirname(startupLauncher), { recursive: true });
      await fs.writeFile(startupLauncher, generateWindowsStartupCommand(psScript), "utf8");
      return "startup-folder";
    }
    if (process.env.APPDATA) await fs.rm(windowsStartupLauncherPath(), { force: true });
  }

  async uninstallService(paths?: InstallPaths): Promise<void> {
    const resolved = paths ?? resolveInstallPaths();
    await this.stopTray();
    // Kill the live pnpm→node tree the task spawned before deleting the task,
    // so no orphan survives the uninstall. `runCommand` never throws, so a
    // missing taskkill or already-dead PID is tolerated.
    const pid = await readServicePid(resolved.pidFile);
    if (pid !== null) {
      // PID identity check: a recycled PID belongs to whatever program the OS
      // handed it to, and force-killing that tree would take down an unrelated
      // app. Only kill a process that is actually the service image.
      const image = await readProcessImageName(pid);
      if (isServiceImageName(image)) {
        await runCommand("taskkill", buildTaskKillArgs(pid));
      } else {
        console.debug(
          `[windows] Not killing pid ${pid}: image is ${image ?? "not running"}, not a Yggdrasil process`,
        );
      }
    }
    // The task name is per-user, not per-install: only end/delete the task when
    // its action points into this base directory.
    const task = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST", "/V"]);
    if (taskBelongsToInstall(task.stdout, resolved.baseDir)) {
      await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
      await runCommand("schtasks", ["/Delete", "/TN", "Yggdrasil", "/F"]);
    } else {
      console.debug("[windows] Task 'Yggdrasil' belongs to another install; leaving it registered");
    }
    if (process.env.APPDATA) {
      await removeLauncherIfOwned(windowsStartupLauncherPath(), resolved.baseDir);
      await removeLauncherIfOwned(
        path.join(path.dirname(windowsStartupLauncherPath()), "Yggdrasil Tray.cmd"),
        resolved.baseDir
      );
    }
  }

  async start(paths?: InstallPaths): Promise<void> {
    // Idempotent: never spawn a second instance. A bare `schtasks /Run` on an
    // already-running task silently launches a duplicate `pnpm start` → a second
    // `next start` on port 2302 and a resource conflict.
    const resolved = paths ?? resolveInstallPaths();
    const { active } = await this.status(resolved);
    if (!shouldStartProcess(active)) return;
    let hasStartupLauncher = false;
    try {
      await fs.access(windowsStartupLauncherPath());
      hasStartupLauncher = true;
    } catch { }
    if (hasStartupLauncher) {
      const script = path.join(resolved.binDir, "start-background.ps1");
      const fallback = await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true });
      if (fallback.code !== 0) throw new Error(`Failed to start Yggdrasil from its Startup launcher: ${fallback.stderr || fallback.stdout}`);
      return;
    }
    const task = await runCommand("schtasks", ["/Run", "/TN", "Yggdrasil"]);
    if (task.code !== 0) throw new Error(`Failed to start Yggdrasil task: ${task.stderr || task.stdout}`);
  }

  async stop(paths?: InstallPaths): Promise<void> {
    const resolved = paths ?? resolveInstallPaths();
    const pid = await readServicePid(resolved.pidFile);
    if (pid !== null) {
      const image = await readProcessImageName(pid);
      if (isServiceImageName(image)) {
        // /T walks the whole process tree (pnpm → node child) and frees the
        // port, which is what prevents the duplicate-conflict after a restart.
        await runCommand("taskkill", buildTaskKillArgs(pid));
        await waitForProcessExit(pid, 10000).catch(() => {});
      } else {
        // The pidfile is stale (or the PID was recycled): never taskkill a
        // process that is not ours.
        console.debug(
          `[windows] Ignoring stale pidfile: pid ${pid} is ${image ?? "not running"}`,
        );
      }
    }
    const task = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST", "/V"]);
    if (taskBelongsToInstall(task.stdout, resolved.baseDir)) {
      await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
    }
  }

  async restart(paths?: InstallPaths): Promise<void> {
    await this.stop(paths);
    await this.start(paths);
  }

  async status(paths?: InstallPaths): Promise<{ active: boolean; details?: string }> {
    // Primary signal: the pidfile written by start-background.ps1, checked for
    // real liveness via tasklist. The PID is language-independent, so this is
    // robust on non-English Windows where `schtasks /Query` localizes
    // "Running" (the old string-match would miss it and let `start()` spawn a
    // duplicate `next start` on the same port).
    const pid = await readServicePid((paths ?? resolveInstallPaths()).pidFile);
    if (pid !== null) {
      // Verify BOTH that the PID is alive and that it is a Yggdrasil image: a
      // bare substring match on the PID number reported any recycled PID as a
      // live server.
      const image = await readProcessImageName(pid);
      const alive = isServiceImageName(image);
      return { active: alive, details: alive ? `pid ${pid} running` : "pidfile stale" };
    }

    // Fallback: no pidfile yet (e.g. a task registered but never run, or a
    // pre-pidfile install). Ask schtasks whether the task is currently running.
    // Accept the localized "Running" substring defensively.
    const res = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST"]);
    const active = /Running/i.test(res.stdout);
    return { active, details: res.stdout || res.stderr };
  }
}
