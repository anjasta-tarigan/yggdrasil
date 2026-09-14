import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { InstallPaths } from "../types";

export function resolveInstallPaths(customBaseDir?: string): InstallPaths {
  const baseDir = customBaseDir ? path.resolve(customBaseDir) : path.join(os.homedir(), ".yggdrasil");
  const dataDir = path.join(baseDir, "data");
  return {
    baseDir,
    appDir: path.join(baseDir, "app"),
    dataDir,
    modelsDir: path.join(dataDir, "models"),
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
    } catch {
      // Ignore if file doesn't exist yet
    }
  }
}

export async function ensureSymlink(target: string, symlinkPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(symlinkPath);
    if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
      await fs.rm(symlinkPath, { recursive: true, force: true });
    }
  } catch {
    // Does not exist
  }
  await fs.symlink(target, symlinkPath, process.platform === "win32" ? "junction" : "dir");
}

export async function addPathToProfile(binDir: string, customProfilePath?: string): Promise<boolean> {
  const profile = customProfilePath || path.join(os.homedir(), ".bashrc");
  let content = "";
  try {
    content = await fs.readFile(profile, "utf8");
  } catch {
    content = "";
  }

  if (content.includes(binDir)) {
    return false;
  }

  const exportLine = `\n# Yggdrasil CLI PATH\nexport PATH="${binDir}:$PATH"\n`;
  await fs.appendFile(profile, exportLine, "utf8");
  return true;
}
