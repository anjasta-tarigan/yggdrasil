import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../utils/exec";
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
WorkingDirectory=%h/.yggdrasil/app
EnvironmentFile=%h/.yggdrasil/.env
Environment=NODE_ENV=production
Environment=PATH=${options.nodeBinDir}:${options.pnpmBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${options.pnpmPath} start
Restart=always
RestartSec=5s
StandardOutput=append:%h/.yggdrasil/data/logs/yggdrasil.log
StandardError=append:%h/.yggdrasil/data/logs/yggdrasil.err.log
${memoryBlock}

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

  async uninstallService(): Promise<void> {
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
