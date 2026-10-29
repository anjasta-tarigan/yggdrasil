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
import { WindowsManager } from "../platform/windows";
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

  if (process.platform === "win32") {
    await new WindowsManager().installTrayLauncher(paths);
    try {
      await new WindowsManager().startTray(paths);
    } catch (err) {
      warn(`Could not start the tray app now; it will still start at sign-in. ${String(err)}`);
    }
  }

  const mgr = getServiceManager();
  const serviceMode = await withSpinner(`Registering ${serviceBackend()}…`, mgr.installService(paths, port));
  if (serviceMode === "startup-folder") {
    warn("Windows could not register a scheduled task. Yggdrasil will start now and at sign-in using your Startup folder; no administrator access is required.");
  }
  step("Background service", serviceMode === "startup-folder" ? "Startup folder (starts at sign-in)" : serviceBackend());

  // The install just (re)generated ~/.yggdrasil/.env (APP_SECRET, NODE_ENV,
  // PORT) and the start-background.ps1 that sources it. If a service from a prior
  // install is already running, mgr.start() is intentionally idempotent and would
  // return early — leaving the STALE process serving the old, secret-less state
  // (the exact symptom of "APP_SECRET is required" + a non-standard NODE_ENV).
  // Detect an already-active service and restart it so the new env + script take
  // effect. A fresh install simply starts.
  const prior = await mgr.status(paths);
  if (prior.active) {
    await withSpinner("Restarting existing service with updated config…", mgr.restart(paths));
  } else {
    await withSpinner("Starting service…", mgr.start(paths));
  }

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
    // Rule 07: Never Crash From Resource Exhaustion. Set a V8 heap ceiling
    // derived from system memory so Node.js GC kicks in before native
    // memory (ONNX, llama.cpp) drives the process into OOM. The value is
    // written into the .env so the systemd EnvironmentFile (and launchd
    // EnvironmentVariables, and the app's own env schema) all see it. Users
    // can override YGGDRASIL_NODE_MAX_OLD_SPACE_MB in .env after install.
    NODE_OPTIONS: computeNodeMaxOldSpace(),
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

  // Self-verify: re-read what we just wrote and confirm a valid APP_SECRET landed.
  // A prior release shipped installs where this step was silently skipped on an
  // existing (but broken) .env, leaving the server to boot without a secret. Fail
  // loudly here so a broken install is never reported as success.
  const written = await fs.readFile(paths.envFile, "utf8");
  const writtenSecret = parseEnvFile(written).get("APP_SECRET") ?? "";
  if (!/^[0-9a-f]{64}$/.test(writtenSecret)) {
    throw new Error(
      `Failed to write a valid APP_SECRET to ${paths.envFile}. ` +
        `The file exists but contains no 64-char hex secret; the server will fail ` +
        `to start. Delete ${paths.envFile} and re-run 'yggdrasil install'.`,
    );
  }

  const note = hadFile
    ? "repaired/kept APP_SECRET + config (mode 600)"
    : "generated APP_SECRET, mode 600";
  step("Environment file", note, Date.now() - started);
}

/**
 * Seeds `~/.yggdrasil/.env` with a valid APP_SECRET and links `app/.env` to it.
 *
 * This MUST run before `pnpm build` (and before the service starts). `next build`
 * evaluates `src/env.ts` (`envSchema.parse(process.env)`) and throws when
 * NODE_ENV=production but APP_SECRET is absent, so if the secret is generated
 * only inside the later `yggdrasil install` step the build aborts *before* that
 * step ever runs — leaving the install secret-less. Both installers therefore
 * call `seed-env` immediately after `pnpm install` and before `pnpm build`.
 *
 * Reuses the same `writeEnvFile` as the install flow (single source of truth for
 * secret generation) and only links the env file, so it is safe to run on a
 * half-built checkout.
 */
export async function seedEnvCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? 2302;
  const paths = resolveInstallPaths(options.dir);
  await writeEnvFile(paths, port);
  await ensureAppEnvLink(paths);
  success(`Seeded ${paths.envFile} (APP_SECRET + config) and linked ${paths.appDir}/.env`);
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

/**
 * Compute the Node.js --max-old-space-size value (in MB) from system memory.
 *
 * Capped to 60% of total RAM, min 1024 MB, max 8192 MB. The user can override
 * via YGGDRASIL_NODE_MAX_OLD_SPACE_MB in the .env file (read at runtime by env.ts).
 */
function computeNodeMaxOldSpace(): string {
  const envOverride = process.env.YGGDRASIL_NODE_MAX_OLD_SPACE_MB;
  if (envOverride) {
    const n = parseInt(envOverride, 10);
    if (Number.isFinite(n) && n > 0) return `--max-old-space-size=${n}`;
  }
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const computed = Math.min(8192, Math.max(1024, Math.round(totalMb * 0.60)));
  return `--max-old-space-size=${computed}`;
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
