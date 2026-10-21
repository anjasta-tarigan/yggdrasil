// src/cli/commands/update.ts
import path from "node:path";
import { resolveInstallPaths, ensureAppEnvLink, ensureGitExcludeEntries } from "../utils/paths";
import { backupDatabaseFiles, restoreDatabaseFiles } from "../utils/backup";
import { runCommand } from "../utils/exec";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import { WindowsManager } from "../platform/windows";
import type { CliOptions } from "../types";

export function findWindowsPnpmCmd(stdout: string): string | null {
  return stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /\.cmd$/i.test(line)) ?? null;
}

export function buildWindowsPnpmArgs(pnpmCmd: string, command: "install" | "build"): string[] {
  return ["/d", "/s", "/c", `\"\"${pnpmCmd}\" ${command}\"`];
}

async function runPnpm(command: "install" | "build", options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  if (process.platform !== "win32") return runCommand("pnpm", [command], options);

  const found = await runCommand("where.exe", ["pnpm.cmd"]);
  const pnpmCmd = findWindowsPnpmCmd(found.stdout);
  if (found.code !== 0 || !pnpmCmd) {
    throw new Error(found.stderr || "Could not locate pnpm.cmd on PATH.");
  }
  return runCommand("cmd.exe", buildWindowsPnpmArgs(pnpmCmd, command), options);
}

export async function updateCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);

  // 0. Unblock installs made before the local exclude file existed.
  //
  // The installer links `app/data` as a symlink, which the repo's `data/`
  // gitignore pattern does not match (trailing slash = directories only). Such
  // a checkout reports `?? data`, and the dirty-tree check below would refuse
  // the update — a deadlock, since this update is what would carry the fix.
  // Adding the local exclude first makes the check pass. Idempotent.
  await ensureGitExcludeEntries(paths.appDir, ["/data", "/.env"]);

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
  await mgr.stop(paths);

  console.log(`[Yggdrasil] Backing up SQLite database...`);
  await backupDatabaseFiles(paths.dataDir, backupDest);

  try {
    console.log(`[Yggdrasil] Pulling latest code from main branch...`);
    const fetchRes = await runCommand("git", ["fetch", "origin", "main:refs/remotes/origin/main"], { cwd: paths.appDir });
    if (fetchRes.code !== 0) {
      const fallbackFetch = await runCommand("git", ["fetch", "origin", "main"], { cwd: paths.appDir });
      if (fallbackFetch.code !== 0) throw new Error(fallbackFetch.stderr || fetchRes.stderr);
    }

    const checkoutRes = await runCommand("git", ["checkout", "-B", "main", "origin/main"], { cwd: paths.appDir });
    if (checkoutRes.code !== 0) throw new Error(checkoutRes.stderr);

    // Repairs installs from before the app-root `.env` link existed: without it
    // APP_SECRET never reaches Next.js on macOS/Windows. Idempotent.
    await ensureAppEnvLink(paths);

    console.log(`[Yggdrasil] Installing dependencies & building...`);
    const installRes = await runPnpm("install", { cwd: paths.appDir });
    if (installRes.code !== 0) throw new Error(installRes.stderr);

    const buildRes = await runPnpm("build", {
      cwd: paths.appDir,
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=2048",
        NODE_ENV: "production",
      },
    });
    if (buildRes.code !== 0) throw new Error(buildRes.stderr);
    if (process.platform === "win32") {
      await new WindowsManager().installTrayLauncher(paths);
    }
  } catch (err: unknown) {
    console.error(`[Yggdrasil] Update failed! Rolling back to ${prevSha}...`, err);
    // Best-effort recovery. Each step is guarded so a failure here cannot
    // replace the original error with a secondary one — the caller needs to
    // see WHY the update failed, not that the cleanup tripped.
    try {
      await runCommand("git", ["reset", "--hard", prevSha], { cwd: paths.appDir });
    } catch (rollbackErr) {
      console.error("[Yggdrasil] Rollback: git reset failed.", rollbackErr);
    }
    try {
      await restoreDatabaseFiles(backupDest, paths.dataDir);
    } catch (restoreErr) {
      console.error("[Yggdrasil] Rollback: database restore failed.", restoreErr);
    }
    try {
      await mgr.start(paths);
    } catch (startErr) {
      console.error("[Yggdrasil] Rollback: service restart failed.", startErr);
    }
    throw err;
  }

  await mgr.start(paths);
  const ok = await waitForHealth("http://localhost:2302/api/health", 30000);
  console.log(ok ? "[Yggdrasil] Successfully updated and verified healthy!" : "[Yggdrasil] Update complete; verifying health...");
}
