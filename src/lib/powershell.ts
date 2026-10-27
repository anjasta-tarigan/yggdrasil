// src/lib/powershell.ts
import fs from "node:fs";
import path from "node:path";

/**
 * Which PowerShell to spawn on Windows.
 *
 * The agent shell, the host sandbox and the project prompt must all agree on
 * one shell, otherwise the prompt tells the model to use `&&` while the spawn
 * target is Windows PowerShell 5.1 (where `&&` is a parse error). Resolution
 * prefers PowerShell 7+ (`pwsh.exe`) because it is dramatically faster to
 * start, emits UTF-8, and supports `&&`/`||` — and falls back to the Windows
 * PowerShell 5.1 that ships with every Windows install.
 */
export type PowerShellEdition = "core" | "desktop";

export interface PowerShellShell {
  /** Absolute path when resolvable, otherwise the bare executable name. */
  exe: string;
  name: "pwsh.exe" | "powershell.exe";
  edition: PowerShellEdition;
  /** Human-readable description used in the system prompt. */
  label: string;
  /** PowerShell 7+ parses `&&` and `||`; 5.1 does not. */
  supportsAndAnd: boolean;
}

const DEFAULT_SYSTEM_ROOT = "C:\\Windows";
const DEFAULT_PROGRAM_FILES = "C:\\Program Files";

function isFile(candidate: string): boolean {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function describe(exe: string, edition: PowerShellEdition): PowerShellShell {
  const name = path.basename(exe).toLowerCase() === "pwsh.exe" ? "pwsh.exe" : "powershell.exe";
  return {
    exe,
    name,
    edition,
    label:
      edition === "core"
        ? `${name} (PowerShell 7+)`
        : `${name} (Windows PowerShell 5.1)`,
    supportsAndAnd: edition === "core",
  };
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
  return [
    path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    path.join(programFiles, "PowerShell", "6", "pwsh.exe"),
    localAppData && path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe"),
    localAppData && path.join(localAppData, "Microsoft", "PowerShell", "7", "pwsh.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

function desktopFallback(env: Record<string, string | undefined>): PowerShellShell {
  const systemRoot = env.SystemRoot || env.windir || DEFAULT_SYSTEM_ROOT;
  const exe = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return describe(exe, "desktop");
}

let cached: { key: string; shell: PowerShellShell } | null = null;

/**
 * Resolve the PowerShell executable for the given environment.
 *
 * Order: explicit `YGGDRASIL_POWERSHELL` override → `pwsh.exe` on PATH →
 * well-known PowerShell 7/6 install locations → Windows PowerShell 5.1.
 * Results are cached per environment key because this runs on every command.
 */
export function resolvePowerShell(
  env: Record<string, string | undefined> = process.env
): PowerShellShell {
  const override = env.YGGDRASIL_POWERSHELL;
  const key = [
    override ?? "",
    env.PATH ?? env.Path ?? "",
    env.ProgramFiles ?? "",
    env.LOCALAPPDATA ?? "",
    env.SystemRoot ?? "",
    env.windir ?? "",
  ].join("\u0000");
  if (cached?.key === key) return cached.shell;

  let shell: PowerShellShell | null = null;
  if (override) {
    const edition: PowerShellEdition =
      path.basename(override).toLowerCase().startsWith("pwsh") ? "core" : "desktop";
    shell = describe(override, edition);
  }
  if (!shell) {
    const onPath = fromPath(env);
    if (onPath) shell = describe(onPath, "core");
  }
  if (!shell) {
    const known = knownPwshLocations(env).find(isFile);
    if (known) shell = describe(known, "core");
  }
  if (!shell) shell = desktopFallback(env);

  cached = { key, shell };
  return shell;
}

/** Test hook: drop the per-environment cache. */
export function resetPowerShellCache(): void {
  cached = null;
}
