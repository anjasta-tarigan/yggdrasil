// src/cli/commands/update.ts
import path from "node:path";
import { resolveInstallPaths } from "../utils/paths";
import { backupDatabaseFiles, restoreDatabaseFiles } from "../utils/backup";
import { runCommand } from "../utils/exec";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

export async function updateCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);

  // 1. Safety check
  const statusRes = await runCommand("git", ["status", "--porcelain"], { cwd: paths.appDir });
  if (statusRes.stdout.trim().length > 0) {
    throw new Error("Working tree in app directory is dirty. Please commit or stash changes before updating.");
  }

  const prevShaRes = await runCommand("git", ["rev-parse", "HEAD"], { cwd: paths.appDir });
  const prevSha = prevShaRes.stdout.trim();
  const backupDest = path.join(paths.dataDir, "backups", `backup-${Date.now()}`);

  console.log(`[Yggdrasil] Stopping service for atomic update...`);
  const mgr = getServiceManager();
  await mgr.stop();

  console.log(`[Yggdrasil] Backing up SQLite database...`);
  await backupDatabaseFiles(paths.dataDir, backupDest);

  try {
    console.log(`[Yggdrasil] Pulling latest code from main branch...`);
    const fetchRes = await runCommand("git", ["fetch", "origin", "main"], { cwd: paths.appDir });
    if (fetchRes.code !== 0) throw new Error(fetchRes.stderr);

    const checkoutRes = await runCommand("git", ["checkout", "main"], { cwd: paths.appDir });
    if (checkoutRes.code !== 0) throw new Error(checkoutRes.stderr);

    const mergeRes = await runCommand("git", ["merge", "--ff-only", "origin/main"], { cwd: paths.appDir });
    if (mergeRes.code !== 0) throw new Error(mergeRes.stderr);

    console.log(`[Yggdrasil] Installing dependencies & building...`);
    const installRes = await runCommand("pnpm", ["install"], { cwd: paths.appDir });
    if (installRes.code !== 0) throw new Error(installRes.stderr);

    const buildRes = await runCommand("pnpm", ["build"], { cwd: paths.appDir });
    if (buildRes.code !== 0) throw new Error(buildRes.stderr);
  } catch (err: unknown) {
    console.error(`[Yggdrasil] Update failed! Rolling back to ${prevSha}...`, err);
    await runCommand("git", ["reset", "--hard", prevSha], { cwd: paths.appDir });
    await restoreDatabaseFiles(backupDest, paths.dataDir);
    await mgr.start();
    throw err;
  }

  await mgr.start();
  const ok = await waitForHealth("http://localhost:2302/api/health", 30000);
  console.log(ok ? "[Yggdrasil] Successfully updated and verified healthy!" : "[Yggdrasil] Update complete; verifying health...");
}
