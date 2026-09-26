import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { InstallPaths } from "../types";

export function resolveInstallPaths(customBaseDir?: string): InstallPaths {
  const baseDir = customBaseDir ? path.resolve(customBaseDir) : path.join(os.homedir(), ".yggdrasil");
  const dataDir = path.join(baseDir, "data");
  const modelsDir = path.join(dataDir, "models");
  return {
    baseDir,
    appDir: path.join(baseDir, "app"),
    dataDir,
    modelsDir,
    rerankerDir: path.join(modelsDir, "reranker"),
    logsDir: path.join(dataDir, "logs"),
    skillsDir: path.join(dataDir, "skills"),
    pluginsDir: path.join(dataDir, "plugins"),
    envFile: path.join(baseDir, ".env"),
    pidFile: path.join(baseDir, "yggdrasil.pid"),
    binDir: path.join(baseDir, "bin"),
  };
}

export async function ensureSecurePermissions(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    try {
      await fs.chmod(filePath, 0o600);
    } catch (err) {
      console.debug(`[paths] Error: ${err instanceof Error ? err.message : String(err)}`);
      // Ignore if file doesn't exist yet
    }
  }
}

export async function ensureSymlink(
  target: string,
  symlinkPath: string,
  kind: "dir" | "file" = "dir"
): Promise<void> {
  try {
    const stat = await fs.lstat(symlinkPath);
    if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
      await fs.rm(symlinkPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.debug(`[paths] Error: ${err instanceof Error ? err.message : String(err)}`);
    // Does not exist
  }
  await fs.mkdir(path.dirname(symlinkPath), { recursive: true });
  // Windows junctions only link directories; a file link needs a real symlink
  // (elevation or Developer Mode), so callers use "dir" there.
  await fs.symlink(target, symlinkPath, process.platform === "win32" ? "junction" : kind);
}

/**
 * Makes `<appDir>/.env` resolve to the canonical `<baseDir>/.env`.
 *
 * Next.js loads env files from its project root — the cwd the service runs in,
 * which is `app/` — not from the base dir the installer writes to. Without this
 * link APP_SECRET is unset at runtime on macOS and Windows (systemd's
 * EnvironmentFile happens to cover Linux only). Idempotent, so `install` and
 * `update` can both call it. Windows junctions cannot target files, so it copies
 * instead.
 */
export async function ensureAppEnvLink(paths: InstallPaths): Promise<void> {
  const appEnv = path.join(paths.appDir, ".env");
  if (process.platform === "win32") {
    await fs.copyFile(paths.envFile, appEnv);
    await ensureSecurePermissions(appEnv);
    return;
  }
  await ensureSymlink(paths.envFile, appEnv, "file");
}

/**
 * Adds entries to the installed checkout's `.git/info/exclude`.
 *
 * The installer links `app/data` (and `app/.env`) as symlinks. The repo's
 * `.gitignore` cannot be relied on to cover them: a `data/` pattern matches
 * directories only, never a symlink, so `git status` in an installed checkout
 * reports `?? data`. `yggdrasil update` reads that as a dirty tree and refuses
 * to run — a deadlock, because the fix would have to arrive through the update
 * that is blocked.
 *
 * `.git/info/exclude` is a local, untracked ignore file, so this works even on
 * an install whose `.gitignore` predates the fix. Idempotent: an entry already
 * present is left alone.
 */
export async function ensureGitExcludeEntries(
  appDir: string,
  entries: string[]
): Promise<void> {
  const excludePath = path.join(appDir, ".git", "info", "exclude");
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch (err) {
    console.debug(`[paths] No existing git exclude file: ${err instanceof Error ? err.message : String(err)}`);
  }

  const present = new Set(
    existing.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  );
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;

  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.appendFile(
    excludePath,
    `${separator}# Added by the Yggdrasil installer (local symlinks; not committed)\n${missing.join("\n")}\n`,
    "utf8"
  );
}

export async function addPathToProfile(binDir: string, customProfilePath?: string): Promise<boolean> {
  const profile = customProfilePath || path.join(os.homedir(), ".bashrc");
  let content = "";
  try {
    content = await fs.readFile(profile, "utf8");
  } catch (err) {
    console.debug(`[paths] Error: ${err instanceof Error ? err.message : String(err)}`);
    content = "";
  }

  if (content.includes(binDir)) {
    return false;
  }

  const exportLine = `\n# Yggdrasil CLI PATH\nexport PATH="${binDir}:$PATH"\n`;
  await fs.appendFile(profile, exportLine, "utf8");
  return true;
}
