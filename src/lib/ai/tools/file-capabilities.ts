// src/lib/ai/tools/file-capabilities.ts
import { spawn } from "node:child_process";

export interface HostCliCapabilities {
  hasEza: boolean;
  hasFd: boolean;
  hasRipgrep: boolean;
  hasZoxide: boolean;
  hasFzf: boolean;
}

let cachedCapabilities: HostCliCapabilities | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function checkCommand(binName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [binName], {
      stdio: "ignore",
      shell: false,
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export async function probeCliCapabilities(forceRefresh = false): Promise<HostCliCapabilities> {
  const now = Date.now();
  if (!forceRefresh && cachedCapabilities && now < cacheExpiry) {
    return cachedCapabilities;
  }

  const [hasEza, hasFd, hasRipgrep, hasZoxide, hasFzf] = await Promise.all([
    checkCommand("eza"),
    checkCommand("fd"),
    checkCommand("rg"),
    checkCommand("zoxide"),
    checkCommand("fzf"),
  ]);

  cachedCapabilities = {
    hasEza,
    hasFd,
    hasRipgrep,
    hasZoxide,
    hasFzf,
  };
  cacheExpiry = now + CACHE_TTL_MS;

  return cachedCapabilities;
}
