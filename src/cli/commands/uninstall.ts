// src/cli/commands/uninstall.ts
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { resolveInstallPaths } from "../utils/paths";
import { waitForProcessExit } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

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

  // Remove symlinks
  if (process.platform !== "win32") {
    const symlink = path.join(env.HOME || "", ".local", "bin", "yggdrasil");
    await fs.rm(symlink, { force: true });
  }

  if (options.purge) {
    console.log(`[Yggdrasil] Purging entire directory ${paths.baseDir}...`);
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  } else {
    console.log(`[Yggdrasil] Preserving data in ${paths.dataDir}; removing app binaries...`);
    await fs.rm(paths.appDir, { recursive: true, force: true });
  }

  console.log(`[Yggdrasil] Uninstallation completed.`);
}
