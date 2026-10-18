import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { InstallPaths } from "../types";

/**
 * The install flow probes files that legitimately do not exist on a fresh
 * install (providers.secrets.env, app/data, .bashrc), so ENOENT from those
 * probes is expected silence. Anything else (EACCES, EISDIR) is a real fault
 * and must stay visible — never suppress errors wholesale.
 */
function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function logUnexpected(label: string, err: unknown): void {
  if (!isNotFound(err)) {
    console.debug(`[paths] ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
      logUnexpected("chmod", err);
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
    logUnexpected("lstat", err);
    // Absent path is the expected "nothing to replace" case.
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
    logUnexpected("read git exclude", err);
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

export async function addPathToProfile(
  binDir: string,
  customProfilePath?: string,
): Promise<boolean> {
  const profile = customProfilePath || path.join(os.homedir(), ".bashrc");
  let content = "";
  try {
    content = await fs.readFile(/* turbopackIgnore: true */ profile, "utf8");
  } catch (err) {
    logUnexpected("read profile", err);
    // Missing rc file: the export line is created below.
    content = "";
  }

  if (content.includes(binDir)) {
    return false;
  }

  const exportLine = `\n# Yggdrasil CLI PATH\nexport PATH="${binDir}:$PATH"\n`;
  await fs.appendFile(profile, exportLine, "utf8");
  return true;
}

/**
 * Adds a directory to the Windows user PATH environment variable via the
 * registry (`HKCU:\Environment\Path`). This makes `yggdrasil` callable from
 * new terminals without requiring a restart of the current shell.
 *
 * Falls back to a no-op with a warning if registry access fails, so the
 * installer never fails solely because PATH registration was denied.
 */
export async function addPathToWindowsUserPath(binDir: string): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    // Ensure the directory exists before adding it to PATH.
    await fs.mkdir(binDir, { recursive: true });

    // Read the current user PATH from the registry.
    const { stdout: regOutput } = await execFileAsync("reg", [
      "query",
      "HKCU\\Environment",
      "/v",
      "Path",
    ]);
    // reg output looks like: "Path    REG_EXPAND_SZ    C:\foo;C:\bar"
    const match = regOutput.match(/REG_EXPAND_SZ\s+(.+)/);
    const currentPath = match ? match[1].trim() : "";
    const existingPaths = currentPath
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (existingPaths.includes(binDir)) {
      return false; // Already in PATH
    }

    const newPath = [...existingPaths, binDir].join(";");

    // Write back to the registry.
    await execFileAsync("reg", [
      "add",
      "HKCU\\Environment",
      "/v",
      "Path",
      "/t",
      "REG_EXPAND_SZ",
      "/d",
      newPath,
      "/f",
    ]);

    return true;
  } catch (err) {
    // If the Path key doesn't exist yet, create it.
    if (err instanceof Error && err.message.toLowerCase().includes("file not found")) {
      try {
        const newPath = binDir;
        await execFileAsync("reg", [
          "add",
          "HKCU\\Environment",
          "/v",
          "Path",
          "/t",
          "REG_EXPAND_SZ",
          "/d",
          newPath,
          "/f",
        ]);
        return true;
      } catch (createErr) {
        console.debug(
          `[paths] Failed to create user PATH: ${createErr instanceof Error ? createErr.message : String(createErr)}`,
        );
        return false;
      }
    }
    console.debug(
      `[paths] Failed to add to user PATH: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Removes the PATH export block that {@link addPathToProfile} writes to a shell
 * rc file. Called during uninstall so no stale `export PATH=…` line survives.
 *
 * The block looks like:
 *
 * ```
 * # Yggdrasil CLI PATH
 * export PATH="<binDir>:$PATH"
 * ```
 *
 * A leading `\n` (always present from the original append) plus the block and
 * its trailing `\n` are collapsed to a single `\n`, leaving surrounding content
 * untouched. Idempotent: a missing or already-clean profile is a no-op.
 */
export async function removePathFromProfile(customProfilePath?: string): Promise<void> {
  const profile = customProfilePath || path.join(os.homedir(), ".bashrc");
  let content = "";
  try {
    content = await fs.readFile(/* turbopackIgnore: true */ profile, "utf8");
  } catch (err) {
    logUnexpected("read profile", err);
    // Missing rc file: nothing to remove.
    return;
  }

  const blockPattern = /\n# Yggdrasil CLI PATH\nexport PATH="[^"]*"\n/g;
  const cleaned = content.replace(blockPattern, "\n");
  if (cleaned !== content) {
    await fs.writeFile(profile, cleaned, "utf8");
  }
}

/**
 * Removes a directory from the Windows user PATH environment variable via the
 * registry (`HKCU:\Environment\Path`). Called during uninstall.
 * Idempotent: a missing or already-clean PATH is a no-op.
 */
export async function removePathFromWindowsUserPath(binDir: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    const { stdout: regOutput } = await execFileAsync("reg", [
      "query",
      "HKCU\\Environment",
      "/v",
      "Path",
    ]);
    const match = regOutput.match(/REG_EXPAND_SZ\s+(.+)/);
    const currentPath = match ? match[1].trim() : "";
    const paths = currentPath
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const filtered = paths.filter((p) => p !== binDir);
    if (filtered.length === paths.length) {
      return; // binDir was not in PATH
    }

    const newPath = filtered.join(";");
    await execFileAsync("reg", [
      "add",
      "HKCU\\Environment",
      "/v",
      "Path",
      "/t",
      "REG_EXPAND_SZ",
      "/d",
      newPath,
      "/f",
    ]);
  } catch (err) {
    logUnexpected("removePathFromWindowsUserPath", err);
  }
}
