import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { InstallPaths } from "../types";

type ExecFileAsync = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const execFileAsync = promisify(execFile) as unknown as ExecFileAsync;

function windowsRegistryMutationAllowed(): boolean {
  // Windows user-PATH registration writes the real HKCU\Environment\Path value.
  // During tests we MUST NOT mutate the developer's actual PATH — running the
  // suite on Windows would otherwise clobber or wipe the real user environment
  // (the bin.test.ts install/uninstall cases run the real command against a
  // temp --dir). Vitest sets VITEST in both the runner and the spawned child,
  // so any automated run is safely excluded here.
  return process.env.VITEST === undefined;
}

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
/** Split a raw `reg query` value line into its type and value, tolerating
 *  REG_SZ / REG_EXPAND_SZ and values that themselves contain "REG_SZ". */
function parseRegValueLine(line: string): { type: string; value: string } | null {
  // `reg query` prints the value type in uppercase, but the match must not
  // depend on it: a lowercase type would otherwise read as "unparseable" and
  // abort every PATH write on that machine.
  const m = line.trimEnd().match(/^\s*Path\s+(REG_[A-Z_]+)\s+(.*)$/i);
  if (!m) return null;
  return { type: m[1].toUpperCase(), value: m[2].trim() };
}

export function parseUserPathOutput(stdout: string): { value: string; type: string } {
  if (/^\s*ERROR:/m.test(stdout)) throw new Error("Could not read HKCU\\Environment\\Path without data loss risk");
  const line = stdout.split("\n").find((l) => /^\s*Path\s+/i.test(l));
  const parsed = line ? parseRegValueLine(line) : null;
  if (line && !parsed) throw new Error("Could not read HKCU\\Environment\\Path without data loss risk");
  return parsed ?? { value: "", type: "REG_EXPAND_SZ" };
}

/** Read the existing user PATH (HKCU\Environment\Path); errors must fail closed. */
async function readUserPath(): Promise<{ value: string; type: string }> {
  const { stdout } = await execFileAsync("reg", ["query", "HKCU\\Environment"]);
  return parseUserPathOutput(stdout);
}

/**
 * Broadcasts WM_SETTINGCHANGE so already-open shells can pick up a new PATH.
 *
 * Deliberately does NOT go through `[Environment]::SetEnvironmentVariable`:
 * that managed setter re-reads the value in *unexpanded* form and writes it
 * back expanded, which (a) permanently expands every `%VAR%` in the user PATH
 * and (b) rewrites a REG_EXPAND_SZ value as REG_SZ. Both losses are
 * irreversible and were the documented cause of corrupted PATHs. This sends
 * the notification only; the registry value written by `reg add` is untouched.
 */
function broadcastEnvChange(): void {
  if (!windowsRegistryMutationAllowed()) return; // never touch real PATH in tests
  try {
    const script =
      "Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '" +
      "[DllImport(\"user32.dll\", SetLastError = true, CharSet = CharSet.Auto)]" +
      "public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam," +
      "string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; " +
      "[Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero," +
      "'Environment', 2, 5000, [ref]([UIntPtr]::Zero)) | Out-Null";
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
      () => {
        // Best-effort; a new terminal reads the registry regardless.
      },
    );
  } catch {
    // Best-effort; the new terminal will read the registry regardless.
  }
}

/** Result of a Windows user-PATH registration attempt. */
export type PathAddResult = "added" | "present" | "failed";

export async function addPathToWindowsUserPath(binDir: string): Promise<PathAddResult> {
  if (!windowsRegistryMutationAllowed()) {
    console.debug(`[paths] Test mode: skipping Windows user-PATH registration for ${binDir}`);
    return "added";
  }
  try {
    // Ensure the directory exists before adding it to PATH.
    await fs.mkdir(binDir, { recursive: true });

    // The user PATH value type is normally REG_EXPAND_SZ, but on many systems it
    // is REG_SZ, and on a brand-new profile the value may not exist at all. The
    // old code matched only REG_EXPAND_SZ, so a REG_SZ value read back empty and
    // the write replaced the *entire* existing PATH. Preserve its type and fail
    // closed if the registry value cannot be read reliably.
    const parsed = await readUserPath();
    const existing = parsed.value;
    const existingPaths = existing
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (existingPaths.some((p) => p.toLowerCase() === binDir.toLowerCase())) {
      return "present"; // Already in PATH
    }

    const newPath = [...existingPaths, binDir].join(";");

    // Data-loss guard: if the new value is shorter than what we read, the read
    // was likely truncated (or the existing PATH had unparsed content) and
    // writing it would WIPE the user's real PATH. Never shrink it — bail out.
    if (newPath.length < existing.length) {
      console.warn(
        `[paths] Refusing to shrink user PATH (${existing.length} -> ${newPath.length} chars). ` +
        `Aborting registration to avoid clobbering existing entries.`,
      );
      return "failed";
    }

    // Preserve the existing registry value type.
    const type = parsed.type;

    await execFileAsync("reg", [
      "add",
      "HKCU\\Environment",
      "/v",
      "Path",
      "/t",
      type,
      "/d",
      newPath,
      "/f",
    ]);

    broadcastEnvChange();
    return "added";
  } catch (err) {
    console.debug(
      `[paths] Failed to add to user PATH: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
}

/**
 * Strips `binDir` from a raw PATH string, tolerating REG_SZ / REG_EXPAND_SZ.
 *
 * Returns `raw` byte-for-byte when `binDir` is absent. Rebuilding the string
 * unconditionally would re-join (and therefore silently normalize) an
 * unrelated user PATH on every uninstall, even when there was nothing to
 * remove.
 */
export function filterRegPath(raw: string | null, binDir: string): string {
  const original = raw ?? "";
  const entries = original
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const target = binDir.trim().toLowerCase();
  const kept = entries.filter((p) => p.toLowerCase() !== target);
  if (kept.length === entries.length) return original;
  return kept.join(";");
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
  if (!windowsRegistryMutationAllowed()) {
    console.debug(`[paths] Test mode: skipping Windows user-PATH removal for ${binDir}`);
    return;
  }
  try {
    const parsed = await readUserPath();

    const newPath = filterRegPath(parsed.value, binDir);
    if (newPath === parsed.value) {
      return; // binDir was not in PATH
    }

    // Data-loss guard: removal must only ever DROP the single binDir token. If
    // the result is unexpectedly shorter than (existing minus one entry), the
    // parse was wrong and writing it would wipe unrelated entries. Bail out.
    const expectedMin = Math.max(0, parsed.value.length - binDir.length - 1);
    if (newPath.length < expectedMin) {
      console.warn(
        `[paths] Refusing to rewrite user PATH on removal (${parsed.value.length} -> ${newPath.length} chars). ` +
        `Aborting to avoid clobbering existing entries.`,
      );
      return;
    }

    await execFileAsync("reg", [
      "add",
      "HKCU\\Environment",
      "/v",
      "Path",
      "/t",
      parsed.type,
      "/d",
      newPath,
      "/f",
    ]);
    broadcastEnvChange();
  } catch (err) {
    logUnexpected("removePathFromWindowsUserPath", err);
  }
}
