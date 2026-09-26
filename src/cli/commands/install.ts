// src/cli/commands/install.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveInstallPaths, ensureSymlink, ensureSecurePermissions, ensureAppEnvLink, ensureGitExcludeEntries, addPathToProfile } from "../utils/paths";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import { heading, step, success, warn, panel, withSpinner, colorEnabled, type PanelRow } from "../utils/format";
import type { CliOptions, InstallPaths } from "../types";

// This module must NOT import `@/env`: that schema parses at import time and
// rejects a production run without APP_SECRET — which is exactly the value this
// command exists to generate. Read HOME from the OS instead.

/** Filename the reranker auto-discovers in `data/models/reranker`; anything
 *  smaller than 50 MB is treated as an incomplete download by the app. */
const DEFAULT_RERANKER_MODEL = "bge-reranker-v2-m3-int8.onnx";

export async function installCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? 2302;
  const paths = resolveInstallPaths(options.dir);

  heading(`Yggdrasil installer — ${paths.baseDir}`);

  await prepareDirectories(paths);
  await writeEnvFile(paths, port);
  await linkRuntimeState(paths);

  if (process.platform !== "win32") {
    await installCliOnPath(paths);
  }

  if (options.noService) {
    step("Background service", "skipped (--no-service)");
    summaryPanel(paths, port, { service: "skipped" });
    return;
  }

  const mgr = getServiceManager();
  await withSpinner(`Registering ${serviceBackend()}…`, mgr.installService(paths, port));
  step("Background service", serviceBackend());
  await withSpinner("Starting service…", mgr.start());

  const healthUrl = `http://localhost:${port}/api/health`;
  const healthy = await waitForHealthLogged(healthUrl, 30000);
  if (healthy) {
    success(`Health check passed — http://localhost:${port} is live`);
  } else {
    warn(`Service started but health check timed out after 30s. Check logs at ${paths.logsDir}`);
  }

  summaryPanel(paths, port, { service: healthy ? "healthy" : "pending" });
}

async function prepareDirectories(paths: InstallPaths): Promise<void> {
  const started = Date.now();
  const dirs = [paths.logsDir, paths.modelsDir, paths.rerankerDir, paths.skillsDir, paths.pluginsDir];
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
  step("Preparing directories", `${dirs.length} under ${paths.dataDir}`, Date.now() - started);
}

/** Creates `~/.yggdrasil/.env` with a fresh APP_SECRET, or leaves it untouched. */
async function writeEnvFile(paths: InstallPaths, port: number): Promise<void> {
  const started = Date.now();
  // The .env holds APP_SECRET and providers.secrets.env holds API keys, so both
  // need owner-only treatment. Re-chmod on every install (idempotent) so a
  // pre-existing secrets file left world-readable by an older run is corrected.
  await ensureSecurePermissions(path.join(paths.dataDir, "providers.secrets.env"));

  const envExists = await fs
    .access(paths.envFile)
    .then(() => true)
    .catch(() => false); // ENOENT is the expected "needs creating" case.

  if (envExists) {
    step("Environment file", `kept existing ${paths.envFile}`, Date.now() - started);
    return;
  }

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
  await ensureSecurePermissions(paths.envFile);
  step("Environment file", "generated APP_SECRET, mode 600", Date.now() - started);
}

async function linkRuntimeState(paths: InstallPaths): Promise<void> {
  const started = Date.now();
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
  step("Linking data & env", "app/data, app/.env, git exclude", Date.now() - started);
}

async function installCliOnPath(paths: InstallPaths): Promise<void> {
  const started = Date.now();
  const localBin = path.join(os.homedir(), ".local", "bin");
  await fs.mkdir(localBin, { recursive: true });
  await ensureSymlink(
    path.join(paths.appDir, "bin", "yggdrasil.mjs"),
    path.join(localBin, "yggdrasil"),
    "file"
  );
  await addPathToProfile(localBin);
  step("CLI on PATH", localBin, Date.now() - started);
}

function serviceBackend(): string {
  if (process.platform === "linux") return "systemd user unit";
  if (process.platform === "darwin") return "launchd agent";
  if (process.platform === "win32") return "scheduled task";
  return "background service";
}

/** Poll health while ticking elapsed time on the spinner line, then settle it. */
async function waitForHealthLogged(url: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  // Only animate on a TTY; redirected output must stay plain text.
  const animate = colorEnabled();
  const ticker = animate
    ? setInterval(
        () =>
          process.stdout.write(
            `\x1b[2K\r… health check on ${url} (${((Date.now() - started) / 1000).toFixed(0)}s)`
          ),
        1000
      )
    : undefined;
  try {
    return await waitForHealth(url, timeoutMs);
  } finally {
    if (ticker) {
      clearInterval(ticker);
      process.stdout.write("\x1b[2K\r");
    }
  }
}

type ServiceState = "healthy" | "pending" | "skipped";

/** Closing panel: where the app lives, plus the optional-feature notes. */
function summaryPanel(paths: InstallPaths, port: number, { service }: { service: ServiceState }): void {
  const rows: PanelRow[] = [
    service === "skipped" ? ["Start", "yggdrasil start"] : ["URL", `http://localhost:${port}`],
    ["Data", paths.dataDir],
    ["Logs", paths.logsDir],
    "",
    "Optional — configure after install:",
    `  Web search  EXA_API_KEY | FIRECRAWL_API_KEY | SEARXNG_BASE_URL,`,
    `              or Settings → Tools in the web UI`,
    `  ONNX model  drop ${DEFAULT_RERANKER_MODEL}`,
    `              into ${paths.rerankerDir} (≥50 MB, then yggdrasil restart)`,
  ];
  panel("Yggdrasil installed", rows);
}
