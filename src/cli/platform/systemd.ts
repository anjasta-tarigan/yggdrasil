import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { runCommand } from "../utils/exec";
import { waitForProcessExit } from "../utils/health";
import { resolveInstallPaths } from "../utils/paths";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

/** Format a byte count as a systemd memory specifier (e.g. "4294967296" → "4G"). */
function formatMemorySpecifier(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    const gb = bytes / 1024 ** 3;
    return gb % 1 === 0 ? `${gb.toFixed(0)}G` : `${gb.toFixed(1)}G`;
  }
  return `${Math.round(bytes / 1024 ** 2)}M`;
}

/**
 * Compute the cgroup memory boundaries for the systemd unit.
 *
 * Defaults: MemoryHigh = 60% of system RAM, MemoryMax = 80% of system RAM.
 * Both can be overridden via the YGGDRASIL_MEMORY_HIGH_BYTES /
 * YGGDRASIL_MEMORY_MAX_BYTES environment variables (read from the .env at
 * install time). A value of 0 or absence disables that directive (not
 * recommended — removes the cgroup safety net).
 */
export function computeMemoryLimits(
  totalMemBytes: number,
  env?: Record<string, string | undefined>
): {
  memoryHigh: number;
  memoryMax: number;
} {
  const highEnv = env?.YGGDRASIL_MEMORY_HIGH_BYTES;
  const maxEnv = env?.YGGDRASIL_MEMORY_MAX_BYTES;
  const memoryHigh =
    highEnv && Number.parseInt(highEnv, 10) > 0
      ? Number.parseInt(highEnv, 10)
      : Math.round(totalMemBytes * 0.60);
  const memoryMax =
    maxEnv && Number.parseInt(maxEnv, 10) > 0
      ? Number.parseInt(maxEnv, 10)
      : Math.round(totalMemBytes * 0.80);
  return { memoryHigh, memoryMax };
}

export interface SystemdConfigOptions {
  appDir: string;
  envFile: string;
  logsDir: string;
  pnpmPath: string;
  nodeBinDir: string;
  pnpmBinDir: string;
  /** cgroup hard memory limit (bytes). Omitted when 0. */
  memoryMaxBytes?: number;
  /** cgroup soft memory limit (bytes). Omitted when 0. */
  memoryHighBytes?: number;
  /** OOM killer score adjustment (-1000 to 1000). */
  oomScoreAdjust?: number;
  /** Maximum tasks (threads + processes). */
  tasksMax?: number;
}

export function generateSystemdUnit(options: SystemdConfigOptions): string {
  // Memory cgroup limits (Rule 07: Never Crash From Resource Exhaustion).
  // MemoryHigh triggers kernel reclamation (slowdown) before the hard limit;
  // MemoryMax is the controlled cgroup ceiling — systemd kills the process
  // cleanly within the cgroup rather than letting the kernel OOM killer
  // pick any process to terminate.
  const memoryDirectives: string[] = [];

  if (options.memoryHighBytes && options.memoryHighBytes > 0) {
    memoryDirectives.push(`MemoryHigh=${formatMemorySpecifier(options.memoryHighBytes)}`);
  }
  if (options.memoryMaxBytes && options.memoryMaxBytes > 0) {
    memoryDirectives.push(`MemoryMax=${formatMemorySpecifier(options.memoryMaxBytes)}`);
  }

  // OOMScoreAdjust=-1000 makes the kernel OOM killer never target this process.
  // This is the primary defence against an uncontrolled force-kill: the
  // process keeps running and the cgroup MemoryMax ceiling acts as the
  // controlled safety net instead. Users who prefer to let the kernel handle
  // OOM (e.g. on a shared server) can set YGGDRASIL_OOM_SCORE_ADJUST >= -900.
  const oomScore = options.oomScoreAdjust ?? -1000;
  memoryDirectives.push(`OOMScoreAdjust=${oomScore}`);

  // Limit threads/processes to prevent fork bombs and runaway workers.
  const tasksMax = options.tasksMax ?? 512;
  memoryDirectives.push(`TasksMax=${tasksMax}`);

  const memoryBlock = memoryDirectives.join("\n");

  return `[Unit]
Description=Yggdrasil Personal AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=${options.appDir}
EnvironmentFile=${options.envFile}
Environment=NODE_ENV=production
Environment=PATH=${options.nodeBinDir}:${options.pnpmBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${options.pnpmPath} start
Restart=always
RestartSec=5s
StandardOutput=append:${options.logsDir}/yggdrasil.log
StandardError=append:${options.logsDir}/yggdrasil.err.log}
${memoryBlock}

[Install]
WantedBy=default.target
`;
}

/** Quote one argument for a Desktop Entry `Exec=` value (freedesktop spec). */
export function quoteDesktopExecArg(value: string): string {
  return `"${value.replace(/[\\"`$]/g, (ch) => `\\${ch}`)}"`;
}

export function linuxAutostartPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", "yggdrasil-tray.desktop");
}

export function generateLinuxTrayAutostartEntry(options: {
  scriptPath: string;
  baseDir: string;
  nodePath: string;
  iconPath: string;
}): string {
  const exec = [
    "python3",
    options.scriptPath,
    "--base-dir", options.baseDir,
    "--node", options.nodePath,
  ].map(quoteDesktopExecArg).join(" ");
  return `[Desktop Entry]
Type=Application
Name=Yggdrasil Tray
Comment=Yggdrasil personal AI assistant
Exec=${exec}
Icon=${options.iconPath}
Terminal=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
`;
}

export class SystemdManager implements ServiceManager {
  private unitPath = path.join(os.homedir(), ".config", "systemd", "user", "yggdrasil.service");

  async installTrayLauncher(paths: InstallPaths): Promise<void> {
    await fs.mkdir(paths.binDir, { recursive: true });
    const script = path.join(paths.binDir, "yggdrasil-tray.py");
    await fs.copyFile(path.join(paths.appDir, "scripts", "yggdrasil-tray.py"), script);
    await fs.chmod(script, 0o755);
    // AppIndicator resolves the icon by name from the theme path the script
    // adds; the file must be named after the icon id.
    const icon = path.join(paths.binDir, "yggdrasil-tray.svg");
    await fs.copyFile(path.join(paths.appDir, "site", "favicon.svg"), icon);

    const autostart = linuxAutostartPath();
    await fs.mkdir(path.dirname(autostart), { recursive: true });
    await fs.writeFile(
      autostart,
      generateLinuxTrayAutostartEntry({
        scriptPath: script,
        baseDir: paths.baseDir,
        nodePath: process.execPath,
        iconPath: icon,
      }),
      "utf8"
    );
  }

  async startTray(paths: InstallPaths): Promise<void> {
    if (process.env.VITEST !== undefined) return;
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      throw new Error("no graphical session (DISPLAY and WAYLAND_DISPLAY are unset)");
    }
    const python = await runCommand("which", ["python3"]);
    if (python.code !== 0) {
      throw new Error("python3 is required for the Linux tray icon but was not found on PATH");
    }

    const pidFile = path.join(paths.binDir, "yggdrasil-tray.pid");
    await fs.rm(pidFile, { force: true });
    const logPath = path.join(paths.logsDir, "tray.log");
    const log = await fs.open(logPath, "a");
    const child = spawn(
      "python3",
      [path.join(paths.binDir, "yggdrasil-tray.py"), "--base-dir", paths.baseDir, "--node", process.execPath],
      { detached: true, stdio: ["ignore", log.fd, log.fd] }
    );
    await log.close();

    // The script stays alive, so wait for the pidfile it writes once the
    // indicator is up. Without this a missing typelib or a tray-less desktop
    // would fail silently — the exact symptom this feature exists to fix.
    let exited = false;
    child.once("exit", () => { exited = true; });
    for (let attempt = 0; attempt < 30 && !exited; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        await fs.access(pidFile);
        child.unref();
        return;
      } catch {
        // Not up yet.
      }
    }
    child.unref();
    throw new Error(`tray process did not start; see ${logPath}`);
  }

  async stopTray(paths?: InstallPaths): Promise<void> {
    const resolved = paths ?? resolveInstallPaths();
    const pidFile = path.join(resolved.binDir, "yggdrasil-tray.pid");
    let pid = 0;
    try {
      pid = parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
    } catch {
      return; // absent: nothing running
    }
    if (!Number.isFinite(pid) || pid <= 0) return;
    // A recycled PID belongs to whatever the OS handed it to — only signal a
    // process that is actually our tray script.
    const cmdline = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!cmdline.includes("yggdrasil-tray.py")) return;
    await runCommand("kill", [String(pid)]);
    await waitForProcessExit(pid, 5000).catch(() => {});
    await fs.rm(pidFile, { force: true });
  }

  async installService(paths: InstallPaths): Promise<void> {
    // Enable lingering
    const username = os.userInfo().username;
    await runCommand("loginctl", ["enable-linger", username]);

    const pnpmRes = await runCommand("which", ["pnpm"]);
    const pnpmPath = pnpmRes.code === 0 ? pnpmRes.stdout.trim() : "/usr/local/bin/pnpm";
    const pnpmBinDir = path.dirname(pnpmPath);
    const nodeBinDir = path.dirname(process.execPath);

    // Compute cgroup memory boundaries from system memory, allowing .env
    // overrides for advanced users. This runs at install time, reading the
    // .env file that the installer just wrote (APP_SECRET, PORT, managed
    // env vars) so the directives are baked into the unit file.
    const totalMemBytes = os.totalmem();
    let envOverrides: Record<string, string | undefined> | undefined;
    try {
      const envText = await fs.readFile(paths.envFile, "utf8");
      envOverrides = {};
      for (const line of envText.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) {
          envOverrides[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
    } catch {
      // No .env yet — use defaults computed from totalMemBytes.
    }

    const { memoryHigh, memoryMax } = computeMemoryLimits(totalMemBytes, envOverrides);
    const oomScoreAdjust = envOverrides?.YGGDRASIL_OOM_SCORE_ADJUST
      ? parseInt(envOverrides.YGGDRASIL_OOM_SCORE_ADJUST, 10)
      : -1000;
    const tasksMax = envOverrides?.YGGDRASIL_TASKS_MAX
      ? parseInt(envOverrides.YGGDRASIL_TASKS_MAX, 10)
      : 512;

    const unit = generateSystemdUnit({
      appDir: paths.appDir,
      envFile: paths.envFile,
      logsDir: paths.logsDir,
      pnpmPath,
      nodeBinDir,
      pnpmBinDir,
      memoryMaxBytes: memoryMax > 0 ? memoryMax : undefined,
      memoryHighBytes: memoryHigh > 0 ? memoryHigh : undefined,
      oomScoreAdjust,
      tasksMax,
    });

    await fs.mkdir(path.dirname(this.unitPath), { recursive: true });
    await fs.writeFile(this.unitPath, unit, "utf8");

    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", "yggdrasil"]);
  }

  async uninstallService(paths?: InstallPaths): Promise<void> {
    const resolved = paths ?? resolveInstallPaths();
    await this.stopTray(resolved);
    // The autostart entry is per-user, not per-install: leave another install's
    // launcher alone.
    try {
      const autostart = linuxAutostartPath();
      const entry = await fs.readFile(autostart, "utf8");
      if (entry.includes(resolved.baseDir)) await fs.rm(autostart, { force: true });
    } catch {
      // Absent: nothing to remove.
    }
    await runCommand("systemctl", ["--user", "stop", "yggdrasil"]);
    await runCommand("systemctl", ["--user", "disable", "yggdrasil"]);
    await fs.rm(this.unitPath, { force: true });
    await runCommand("systemctl", ["--user", "daemon-reload"]);
    // Reverse the `loginctl enable-linger` that installService enabled so the
    // user's systemd user instance no longer outlives login sessions.
    const username = os.userInfo().username;
    if (username) {
      await runCommand("loginctl", ["disable-linger", username]);
    }
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
