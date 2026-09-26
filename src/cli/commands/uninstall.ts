// src/cli/commands/uninstall.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInstallPaths, removePathFromProfile } from "../utils/paths";
import { waitForProcessExit } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

// Must NOT import `@/env`: its module-level parse throws in production without
// APP_SECRET, and uninstall is a recovery path that must work even when the
// install is broken. HOME comes from the OS.

export async function uninstallCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);

  console.log(`[Yggdrasil] Stopping and removing service...`);
  const mgr = getServiceManager();
  await mgr.uninstallService();

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

  // Remove CLI symlink and the PATH export block from the shell rc
  // (installCliOnPath is skipped on Windows, so this is non-Windows only).
  if (process.platform !== "win32") {
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
