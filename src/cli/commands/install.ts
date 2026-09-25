// src/cli/commands/install.ts
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { resolveInstallPaths, ensureSymlink, ensureSecurePermissions, addPathToProfile } from "../utils/paths";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

export async function installCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? 2302;
  const paths = resolveInstallPaths(options.dir);

  console.log(`[Yggdrasil] Setting up installation at ${paths.baseDir}...`);
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.modelsDir, { recursive: true });
  await fs.mkdir(paths.rerankerDir, { recursive: true });
  await fs.mkdir(paths.skillsDir, { recursive: true });
  await fs.mkdir(paths.pluginsDir, { recursive: true });

  // Generate .env if absent
  let wroteEnvFile = false;
  const envExists = await fs
    .access(paths.envFile)
    .then(() => true)
    .catch(() => false); // ENOENT is the expected "needs creating" case.
  if (!envExists) {
    const { randomBytes } = await import("node:crypto");
    const secret = randomBytes(32).toString("hex");
    // Create with owner-only mode up front (0600) so the secret is never
    // briefly world-readable between write and chmod.
    await fs.writeFile(
      paths.envFile,
      `PORT=${port}\nNODE_ENV=production\nAPP_SECRET=${secret}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    wroteEnvFile = true;
  }

  // Secure secrets permissions. The .env holds APP_SECRET, so it needs the
  // same owner-only treatment as the provider secrets file.
  if (wroteEnvFile) {
    await ensureSecurePermissions(paths.envFile);
  }
  await ensureSecurePermissions(path.join(paths.dataDir, "providers.secrets.env"));

  // Link app/data to canonical data
  const appData = path.join(paths.appDir, "data");
  await ensureSymlink(paths.dataDir, appData);

  // Next.js loads `.env` from its project root (the cwd the service runs in),
  // which is `app/`, not the base dir the installer writes to. Link it so
  // APP_SECRET and PORT are actually read at runtime on every platform
  // (systemd's EnvironmentFile happens to cover Linux only). On Windows a
  // junction cannot point at a file, so copy the env file instead.
  const appEnv = path.join(paths.appDir, ".env");
  if (process.platform === "win32") {
    await fs.copyFile(paths.envFile, appEnv);
    await ensureSecurePermissions(appEnv);
  } else {
    await ensureSymlink(paths.envFile, appEnv, "file");
  }

  // Install executable link to PATH
  if (process.platform !== "win32") {
    const localBin = path.join(env.HOME || "", ".local", "bin");
    await fs.mkdir(localBin, { recursive: true });
    await ensureSymlink(
      path.join(paths.appDir, "bin", "yggdrasil.mjs"),
      path.join(localBin, "yggdrasil"),
      "file"
    );
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
      console.log(`[Yggdrasil] Optional neural reranker: place bge-reranker-v2-m3-int8.onnx into ${paths.rerankerDir} to activate cross-encoder reranking (defaults to cosine RRF if omitted).`);
    } else {
      console.warn(
        `[Yggdrasil] Service started but health check pending. Check logs at ${paths.logsDir}`
      );
    }
  }
}
