// src/cli/commands/install.ts
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths, ensureSymlink, ensureSecurePermissions, addPathToProfile } from "../utils/paths";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

export async function installCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? 2302;
  const paths = resolveInstallPaths(options.dir);

  console.log(`[Yggdrasil] Setting up installation at ${paths.baseDir}...`);
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.skillsDir, { recursive: true });
  await fs.mkdir(paths.pluginsDir, { recursive: true });

  // Generate .env if absent
  try {
    await fs.access(paths.envFile);
  } catch {
    await fs.writeFile(paths.envFile, `PORT=${port}\nNODE_ENV=production\n`, "utf8");
  }

  // Secure secrets permissions
  await ensureSecurePermissions(path.join(paths.dataDir, "providers.secrets.env"));

  // Link app/data to canonical data
  const appData = path.join(paths.appDir, "data");
  await ensureSymlink(paths.dataDir, appData);

  // Install executable link to PATH
  if (process.platform !== "win32") {
    const localBin = path.join(process.env.HOME || "", ".local", "bin");
    await fs.mkdir(localBin, { recursive: true });
    await ensureSymlink(path.join(paths.appDir, "bin", "yggdrasil.mjs"), path.join(localBin, "yggdrasil"));
    await addPathToProfile(localBin);
  }

  if (!options.noService) {
    console.log(`[Yggdrasil] Registering background daemon service...`);
    const mgr = getServiceManager();
    await mgr.installService(paths, port);
    await mgr.start();

    console.log(`[Yggdrasil] Waiting for system health check on port ${port}...`);
    const ok = await waitForHealth(`http://localhost:${port}/api/health`, 30000);
    if (ok) {
      console.log(`[Yggdrasil] Installed and running successfully at http://localhost:${port}`);
    } else {
      console.warn(`[Yggdrasil] Service started but health check pending. Check logs at ${paths.logsDir}`);
    }
  }
}
