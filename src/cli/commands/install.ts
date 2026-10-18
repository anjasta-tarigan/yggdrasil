// src/cli/commands/install.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveInstallPaths,
  ensureSymlink,
  ensureSecurePermissions,
  ensureAppEnvLink,
  ensureGitExcludeEntries,
  addPathToProfile,
  addPathToWindowsUserPath,
} from "../utils/paths";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import { heading, step, success, warn, panel, withSpinner, colorEnabled, type PanelRow } from "../utils/format";
import type { CliOptions, InstallPaths } from "../types";

// This module must NOT import `@/env`: that schema parses at import time and
// rejects a production run without APP_SECRET — which is exactly the value this
// command exists to generate. Read HOME from the OS instead.

export async function installCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? 2302;
  const paths = resolveInstallPaths(options.dir);

  heading(`Yggdrasil installer — ${paths.baseDir}`);

  await prepareDirectories(paths);
  await writeEnvFile(paths, port);
  await linkRuntimeState(paths);

  await installCliOnPath(paths);

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

/**
 * Parse a simple KEY=VALUE env file, ignoring blank lines and `#` comments.
 * Returns insertion-ordered keys. Used to merge (not clobber) the install's
 * managed keys into any pre-existing .env the user may have edited.
 */
function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

/**
 * Ensures `~/.yggdrasil/.env` carries a valid APP_SECRET (and PORT/NODE_ENV).
 *
 * A previously botched install can leave an empty or partial `.env` behind. The
 * old code skipped generation whenever the file existed, so a stale file with a
 * missing/weak APP_SECRET was shipped as-is and the server booted without a
 * secret (or even without PORT, falling back to Next's default 3000). Now we
 * always repair the managed keys in place, preserving any user-managed provider
 * keys already present.
 */
async function writeEnvFile(paths: InstallPaths, port: number): Promise<void> {
  const started = Date.now();
  // The .env holds APP_SECRET and providers.secrets.env holds API keys, so both
  // need owner-only treatment. Re-chmod on every install (idempotent) so a
  // pre-existing secrets file left world-readable by an older run is corrected.
  await ensureSecurePermissions(path.join(paths.dataDir, "providers.secrets.env"));

  const managed: Record<string, string> = {
    PORT: String(port),
    NODE_ENV: "production",
  };

  let existing = "";
  let hadFile = false;
  try {
    existing = await fs.readFile(paths.envFile, "utf8");
    hadFile = true;
  } catch {
    // ENOENT: fresh install — build from scratch below.
  }

  const parsed = parseEnvFile(existing);

  // Always ensure a valid 32-byte-hex APP_SECRET. A prior install may have been
  // left without one (or with a non-conforming value); never ship that.
  const priorSecret = parsed.get("APP_SECRET") ?? "";
  if (!/^[0-9a-f]{64}$/.test(priorSecret)) {
    const { randomBytes } = await import("node:crypto");
    managed.APP_SECRET = randomBytes(32).toString("hex");
  } else {
    managed.APP_SECRET = priorSecret;
  }

  // Persist the main-channel marker only when requested and/or already present
  // (install.sh reads YGGDRASIL_CHANNEL only to pick the checkout ref).
  if (process.env.YGGDRASIL_CHANNEL === "main") {
    managed.YGGDRASIL_CHANNEL = parsed.get("YGGDRASIL_CHANNEL") ?? "main";
  } else if (parsed.has("YGGDRASIL_CHANNEL")) {
    managed.YGGDRASIL_CHANNEL = parsed.get("YGGDRASIL_CHANNEL")!;
  }

  // Merge: keep any user-added keys, override only the managed ones.
  const merged = new Map(parsed);
  for (const [k, v] of Object.entries(managed)) merged.set(k, v);

  const content = [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  await fs.writeFile(paths.envFile, content, { encoding: "utf8", mode: 0o600 });
  await ensureSecurePermissions(paths.envFile);

  const note = hadFile
    ? "repaired/kept APP_SECRET + config (mode 600)"
    : "generated APP_SECRET, mode 600";
  step("Environment file", note, Date.now() - started);
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

  if (process.platform === "win32") {
    // On Windows, create a batch wrapper in the bin directory and register
    // it in the user PATH via the registry.
    const binDir = paths.binDir;
    await fs.mkdir(binDir, { recursive: true });

    const scriptPath = path.join(paths.appDir, "bin", "yggdrasil.mjs");
    // Batch wrapper that invokes node on the app's CLI entry point.
    // On Windows symlinks for files need elevation/Developer Mode, so we use
    // a .cmd that references the app directory directly.
    const wrapperPath = path.join(binDir, "yggdrasil.cmd");
    const wrapperContent = `@echo off\r\nnode "${scriptPath}" %*\r\n`;
    await fs.writeFile(wrapperPath, wrapperContent, "utf8");

    const result = await addPathToWindowsUserPath(binDir);
    if (result === "failed") {
      // Registration failed (e.g. no registry access). The wrapper exists in
      // binDir, so tell the user to add it manually rather than silently
      // reporting success — a missing PATH is a real, confusing failure.
      warn(
        `Could not register '${binDir}' on the Windows user PATH automatically. ` +
          `Add it to your user PATH (Settings → Environment Variables) or run ` +
          `yggdrasil from its full path: ${path.join(binDir, "yggdrasil.cmd")}`,
      );
    }
    step(
      "CLI on PATH",
      `${binDir} ${result === "added" ? "(added to user PATH)" : result === "present" ? "(already in PATH)" : "(add to PATH manually — see warning)"}`,
      Date.now() - started,
    );
    return;
  }

  // Linux / macOS
  const localBin = path.join(os.homedir(), ".local", "bin");
  await fs.mkdir(localBin, { recursive: true });
  await ensureSymlink(
    path.join(paths.appDir, "bin", "yggdrasil.mjs"),
    path.join(localBin, "yggdrasil"),
    "file",
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
    `  ONNX model  drop your reranker .onnx model file`,
    `              into ${paths.rerankerDir}, then set RERANKER_ENABLED=true`,
    `              in ${paths.envFile} (yggdrasil restart needed)`,
  ];

  panel("Yggdrasil installed successfully", rows);

  if (process.platform === "win32") {
    console.log("");
    console.log("  The 'yggdrasil' command was registered on your user PATH");
    console.log("  (HKCU registry). Open a NEW terminal to use it; an already");
    console.log("  open terminal may need to be restarted to pick up the change.");
    console.log("");
  }
}
