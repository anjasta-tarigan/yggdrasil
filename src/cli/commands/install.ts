// src/cli/commands/install.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInstallPaths, ensureSymlink, ensureSecurePermissions, ensureAppEnvLink, ensureGitExcludeEntries, addPathToProfile } from "../utils/paths";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

// This module must NOT import `@/env`: that schema parses at import time and
// rejects a production run without APP_SECRET — which is exactly the value this
// command exists to generate. Read HOME from the OS instead.

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
    // A main-channel install must persist the marker: install.sh reads
    // YGGDRASIL_CHANNEL only to pick the checkout ref and never writes it, so
    // without this line a documented `YGGDRASIL_CHANNEL=main` install runs with
    // a clean release version and is wrongly reported as a release with a bogus
    // "update available". systemd sources this file (EnvironmentFile) and the
    // app reads it, so the marker reaches both.
    const channelLine = process.env.YGGDRASIL_CHANNEL === "main" ? "YGGDRASIL_CHANNEL=main\n" : "";
    // Create with owner-only mode up front (0600) so the secret is never
    // briefly world-readable between write and chmod.
    await fs.writeFile(
      paths.envFile,
      `PORT=${port}\nNODE_ENV=production\nAPP_SECRET=${secret}\n${channelLine}`,
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

  // The repo's `.gitignore` cannot cover these symlinks (a `data/` pattern
  // matches directories only), so an installed checkout looks dirty to
  // `git status` and `yggdrasil update` refuses to run. Record them in the
  // checkout's local exclude file instead.
  await ensureGitExcludeEntries(paths.appDir, ["/data", "/.env"]);

  // Next.js loads `.env` from its project root (the cwd the service runs in),
  // which is `app/`, not the base dir the installer writes to. Link it so
  // APP_SECRET and PORT are actually read at runtime on every platform
  // (systemd's EnvironmentFile happens to cover Linux only).
  await ensureAppEnvLink(paths);

  // Install executable link to PATH
  if (process.platform !== "win32") {
    const localBin = path.join(os.homedir(), ".local", "bin");
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
