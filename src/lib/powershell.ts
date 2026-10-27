// src/lib/powershell.ts
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Which PowerShell the agent may spawn on Windows.
 *
 * Policy: PowerShell 7+ (`pwsh.exe`) only. Windows PowerShell 5.1 is rejected —
 * it starts in 5-9 s on some hosts, writes OEM-encoded output, and does not
 * understand `&&`, which the system prompt and the shell guardrails assume.
 * A missing or too-old PowerShell is a hard error with install instructions
 * instead of a silent downgrade that makes every command slow and flaky.
 */
export interface PowerShellShell {
  /** Absolute path when resolvable, otherwise the bare executable name. */
  exe: string;
  name: "pwsh.exe";
  /** Human-readable description used in the system prompt. */
  label: string;
}

const MINIMUM_MAJOR_VERSION = 7;
const DEFAULT_PROGRAM_FILES = "C:\\Program Files";

export class PowerShellUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerShellUnavailableError";
  }
}

export function describePowerShell(exe: string): PowerShellShell {
  return {
    exe,
    name: "pwsh.exe",
    label: "pwsh.exe (PowerShell 7+)",
  };
}

function isFile(candidate: string): boolean {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isPwsh(candidate: string): boolean {
  return path.basename(candidate).toLowerCase() === "pwsh.exe";
}

function fromPath(env: Record<string, string | undefined>): string | null {
  const raw = env.PATH ?? env.Path ?? "";
  for (const dir of raw.split(";")) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!trimmed) continue;
    const candidate = path.join(trimmed, "pwsh.exe");
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function knownPwshLocations(env: Record<string, string | undefined>): string[] {
  const programFiles = env.ProgramFiles || DEFAULT_PROGRAM_FILES;
  const localAppData = env.LOCALAPPDATA || "";
  const powershellRoot = path.join(programFiles, "PowerShell");
  // Any major version (7, 8, …), newest first: an install under `PowerShell\8`
  // must not be invisible just because `\7` is the current default.
  let majors: string[] = [];
  try {
    majors = fs
      .readdirSync(powershellRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    // No PowerShell directory — fall through to the other candidates.
  }
  return [
    ...majors.map((major) => path.join(powershellRoot, major, "pwsh.exe")),
    localAppData && path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"),
    localAppData && path.join(localAppData, "Microsoft", "PowerShell", "7", "pwsh.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

let cachedResolution: { key: string; shell: PowerShellShell | null } | null = null;
const versionCache = new Map<string, number | null>();

/**
 * Resolve `pwsh.exe` for the given environment, or `null` when PowerShell 7+
 * is not installed. Resolution order: `YGGDRASIL_POWERSHELL` override →
 * `pwsh.exe` on PATH → well-known PowerShell 7 install locations.
 *
 * A configured Windows PowerShell 5.1 path (`powershell.exe`) is treated as
 * "not installed": the policy rejects it rather than silently downgrading.
 */
export function resolvePowerShell(
  env: Record<string, string | undefined> = process.env
): PowerShellShell | null {
  const override = env.YGGDRASIL_POWERSHELL;
  const key = [
    override ?? "",
    env.PATH ?? env.Path ?? "",
    env.ProgramFiles ?? "",
    env.LOCALAPPDATA ?? "",
  ].join("\u0000");
  if (cachedResolution?.key === key) return cachedResolution.shell;

  let exe: string | null = null;
  if (override) {
    // An explicit override is authoritative: a 5.1 path or a typo is a
    // configuration error, not a reason to silently fall through to another
    // install the user did not ask for.
    exe = isPwsh(override) && isFile(override) ? override : null;
  } else {
    exe = fromPath(env) ?? knownPwshLocations(env).find(isFile) ?? null;
  }

  const shell = exe ? describePowerShell(exe) : null;
  cachedResolution = { key, shell };
  return shell;
}

/** Major version of a `pwsh.exe`, probed once per executable and cached. */
export function getPowerShellMajorVersion(exe: string): Promise<number | null> {
  const known = versionCache.get(exe);
  if (known !== undefined) return Promise.resolve(known);

  return new Promise((resolve) => {
    execFile(
      exe,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"],
      { timeout: 20_000, windowsHide: true },
      (error, stdout) => {
        const parsed = Number.parseInt(String(stdout ?? "").trim(), 10);
        const major = !error && Number.isFinite(parsed) ? parsed : null;
        versionCache.set(exe, major);
        resolve(major);
      }
    );
  });
}

export function powerShellInstallHint(): string {
  return [
    "Install PowerShell 7 (winget):",
    "  winget install --id Microsoft.PowerShell --source winget",
    "or download it from https://aka.ms/powershell, then reopen the app.",
  ].join("\n");
}

/**
 * Resolve and verify PowerShell 7+ before a command is spawned.
 *
 * Throws `PowerShellUnavailableError` when `pwsh.exe` is missing or reports a
 * major version below 7, so the caller surfaces one actionable message instead
 * of running every command through an unsupported shell.
 */
export async function requirePowerShell(
  env: Record<string, string | undefined> = process.env
): Promise<PowerShellShell> {
  const shell = resolvePowerShell(env);
  if (!shell) {
    const override = env.YGGDRASIL_POWERSHELL;
    const detail = override
      ? `YGGDRASIL_POWERSHELL=${override} is not an existing pwsh.exe.`
      : "pwsh.exe was not found on PATH or in the standard install locations.";
    throw new PowerShellUnavailableError(
      `PowerShell 7 or newer is required on Windows, but ${detail}\n${powerShellInstallHint()}`
    );
  }

  const major = await getPowerShellMajorVersion(shell.exe);
  if (major === null) {
    throw new PowerShellUnavailableError(
      `PowerShell 7 or newer is required on Windows, but the version of ${shell.exe} could not be verified.\n${powerShellInstallHint()}`
    );
  }
  if (major < MINIMUM_MAJOR_VERSION) {
    throw new PowerShellUnavailableError(
      `PowerShell ${MINIMUM_MAJOR_VERSION} or newer is required on Windows; ${shell.exe} reports version ${major}.\n${powerShellInstallHint()}`
    );
  }
  return shell;
}

/** Test hook: drop the resolution and version caches. */
export function resetPowerShellCache(): void {
  cachedResolution = null;
  versionCache.clear();
}
