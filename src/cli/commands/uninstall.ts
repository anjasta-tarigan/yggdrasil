// src/cli/commands/uninstall.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveInstallPaths,
  removePathFromProfile,
  removePathFromWindowsUserPath,
} from "../utils/paths";
import { waitForProcessExit } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

// Must NOT import `@/env`: its module-level parse throws in production without
// APP_SECRET, and uninstall is a recovery path that must work even when the
// install is broken. HOME comes from the OS.

/**
 * Directories that must never be recursively deleted, even when the user passes
 * `--dir` for them.
 *
 * The previous code ran `fs.rm(baseDir, { recursive: true })` unconditionally,
 * so a mistyped `--dir C:\Users\me` (or `--dir C:\`) erased the profile or a
 * drive. The installer destroyed machines that way; this is the guard that
 * makes it impossible.
 */
export function isProtectedUninstallTarget(baseDir: string): boolean {
  const resolved = path.resolve(baseDir);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return true; // C:\ (or /)
  if (resolved === path.resolve(os.homedir())) return true;

  if (process.platform === "win32") {
    const systemDirs = ["Windows", "Users", "Program Files", "Program Files (x86)", "ProgramData"];
    const lower = resolved.toLowerCase();
    if (systemDirs.some((dir) => lower === path.join(parsed.root, dir).toLowerCase())) {
      return true;
    }
    // A user profile root: C:\Users\<name>
    if (/^[a-z]:\\users\\[^\\]+$/i.test(resolved)) return true;
  }
  return false;
}

/**
 * True when `baseDir` holds at least one artifact only a Yggdrasil install
 * creates. Used to refuse `uninstall` on an arbitrary directory the user
 * pointed at by mistake.
 */
export async function looksLikeYggdrasilInstall(baseDir: string): Promise<boolean> {
  // A bare `.env` is a weak signal — plenty of unrelated projects have one, and
  // deleting such a directory is exactly the accident this guard exists for.
  // Require an artifact only an install creates.
  const candidates = [
    "yggdrasil.pid",
    path.join("data", "logs"),
    path.join("app", "package.json"),
    path.join("bin", "yggdrasil.mjs"),
    path.join("bin", "start-background.ps1"),
  ];
  for (const rel of candidates) {
    try {
      await fs.access(path.join(baseDir, rel));
      return true;
    } catch {
      // Not this one; keep probing.
    }
  }
  return false;
}

export async function uninstallCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);

  // Ownership checks run BEFORE anything is deleted. An uninstall that cannot
  // prove `baseDir` is ours must stop, not "clean up" whatever it finds.
  if (isProtectedUninstallTarget(paths.baseDir)) {
    throw new Error(
      `Refusing to uninstall ${paths.baseDir}: that is a system or user-profile directory, ` +
        `not a Yggdrasil install directory. Pass --dir with the directory you installed into.`
    );
  }
  if (!(await looksLikeYggdrasilInstall(paths.baseDir))) {
    throw new Error(
      `Refusing to uninstall ${paths.baseDir}: no Yggdrasil installation was found there ` +
        `(expected data/logs, app/, bin/ or yggdrasil.pid). Pass --dir with the directory you installed into.`
    );
  }

  console.log(`[Yggdrasil] Stopping and removing service...`);
  const mgr = getServiceManager();
  await mgr.uninstallService(paths);

  // Wait for process exit if PID exists
  try {
    const pidStr = await fs.readFile(paths.pidFile, "utf8");
    const pid = parseInt(pidStr.trim(), 10);
    if (!isNaN(pid)) {
      await waitForProcessExit(pid, 10000);
    }
  } catch (err) {
    console.debug(`[uninstall] Error: ${err instanceof Error ? err.message : String(err)}`);
    // PID file not present or unreadable
  }

  // Remove CLI from PATH on the appropriate platform.
  if (process.platform === "win32") {
    await removePathFromWindowsUserPath(paths.binDir);
  } else {
    const symlink = path.join(os.homedir(), ".local", "bin", "yggdrasil");
    await fs.rm(symlink, { force: true });
    await removePathFromProfile();
  }

  // The PID file is never user data — remove it so a stale copy doesn't
  // survive into a fresh install.
  await fs.rm(paths.pidFile, { force: true });

  if (options.purge) {
    console.log(`[Yggdrasil] Purging entire directory ${paths.baseDir}...`);
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  } else {
    console.log(`[Yggdrasil] Preserving data in ${paths.dataDir}; removing app binaries...`);
    await fs.rm(paths.appDir, { recursive: true, force: true });
    // binDir holds platform service scripts (e.g. Windows start-background.ps1)
    // and is never user data — remove it even in non-purge mode.
    await fs.rm(paths.binDir, { recursive: true, force: true });
  }

  console.log(`[Yggdrasil] Uninstallation completed.`);
}
