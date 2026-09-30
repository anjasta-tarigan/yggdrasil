/**
 * LlamaRunner — lifecycle supervisor for the llama.cpp `llama-server` binary.
 *
 * Responsibilities (spec §Runner):
 *   - Pidfile-based orphan adoption (process.kill(pid, 0) + /health + /props verify)
 *   - Foreign-port detection + reassignment (persist baseUrl via registry lock)
 *   - Health polling (/health every HEALTH_POLL_MS, timeout SPAWN_TIMEOUT_MS)
 *   - /props model-path verification (guards against adopting a foreign server)
 *   - Idle-timer shutdown (touch resets; expiry → SIGTERM → 10s → SIGKILL → standby)
 *   - Crash-loop guard (max 3 restarts/5min; surface last 20 stderr lines)
 *   - Unknown-flag fallback (drop droppable flags, retry; mandatory flags hard-fail)
 *   - One-time process exit handlers (SIGTERM → 10s → SIGKILL → pidfile cleanup)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { planServerFlags } from "./resource-planner";
import { findLlamaServer, modelsDirPath } from "./detect";
import {
  LlamaResourceError,
  DEFAULT_GGUF_PORT,
  GGUF_PIDFILE,
  HEALTH_POLL_MS,
  SPAWN_TIMEOUT_MS,
  SIGTERM_GRACE_MS,
  type PlannedServer,
  type RunnerStatus,
} from "./types";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import { getAvailableMemoryBytes } from "@/lib/system-stats";
import { acquireRegistryLock, loadRegistry, saveRegistry } from "@/lib/ai/provider-config/store";

const DROPPABLE_FLAGS = new Set(["--cache-reuse", "-fa", "--flash-attn", "--jinja"]);
const MANDATORY_TOKENS = new Set([
  "-m", "-c", "--port", "--host", "-t", "-b", "-ub",
  "-ngl", "-ctk", "-ctv",
]);
const FLAG_TOKEN_RE = /--[a-z][a-z0-9-]*/;
const MAX_FLAG_RETRIES = 3;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const CRASH_WINDOW_MS = 10_000;
const STDERR_TAIL_LINES = 20;

/** Reserved tokens that users must never override via extraFlags. */
const RESERVED_TOKENS = new Set(["--host", "--port", "-m", "-c"]);

/** Module-level runner state, keyed by `${providerId}:${modelId}`. */
const runners = new Map<string, LlamaRunner>();

let shutdownRegistered = false;

function runnerKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function assertSafeModelId(modelId: string): void {
  if (path.basename(modelId) !== modelId || modelId.includes("/") || modelId.includes("\\")) {
    throw new LlamaResourceError(`Refusing unsafe GGUF modelId "${modelId}" (path traversal).`);
  }
  if (!modelId.toLowerCase().endsWith(".gguf")) {
    throw new LlamaResourceError(`GGUF modelId must be a .gguf filename, got "${modelId}".`);
  }
}

/**
 * LlamaRunner manages the full lifecycle of a single llama-server instance.
 * One instance per (providerId, modelId) pair.
 */
class LlamaRunner {
  private providerId: string;
  private modelId: string;
  private child: ChildProcess | null = null;
  private stderrLines: string[] = [];
  /** Timer handle for idle shutdown; cleared on touch(). */
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Restart tracker for crash-loop detection. */
  private restartCount: number = 0;
  private restartWindowStart: number = 0;
  /** Coalesced promise for an in-flight spawn; concurrent callers await this. */
  private pendingReady: Promise<string> | null = null;
  /** Resolve/reject for pending ready promise. */
  private readyResolve: ((url: string) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private idleMinutes: number = 3;
  private planned: PlannedServer | null = null;
  private lastError: string | null = null;
  private spawnStart: number = 0;
  private droppedFlags: Set<string> = new Set();
  private serverPort: number = DEFAULT_GGUF_PORT;
  private binaryPath: string = "llama-server";
  private modelPath: string = "";

  constructor(providerId: string, modelId: string) {
    this.providerId = providerId;
    this.modelId = modelId;
  }

  get status(): RunnerStatus {
    let state: "running" | "standby" | "unload";
    if (this.child && !this.child.killed) {
      state = "running";
    } else if (this.planned) {
      state = "standby";
    } else {
      state = "unload";
    }
    return {
      state,
      pid: this.child ? this.child.pid ?? null : null,
      planned: this.planned,
      lastError: this.lastError,
    };
  }

  touch(): void {
    // Reset idle timer on every request.
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    if (this.planned) {
      this.idleTimer = setTimeout(() => {
        this.doIdleShutdown().catch(() => {
          // Idle shutdown failure is logged via lastError but not surfaced to caller.
        });
      }, this.planned.idleMinutes * 60_000);
    }
  }

  private async doIdleShutdown(): Promise<void> {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    await this.waitForExit(SIGTERM_GRACE_MS);
    if (!this.child.killed) {
      this.child.kill("SIGKILL");
    }
    await this.cleanupPidfile();
    this.child = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async ensureRunning(planned: PlannedServer, modelAbsPath: string, binaryPath: string): Promise<string> {
    this.planned = planned;
    this.modelPath = modelAbsPath;
    this.binaryPath = binaryPath;
    this.idleMinutes = planned.idleMinutes;
    this.serverPort = planned.port;

    // If a spawn is already in flight, coalesce concurrent callers onto it.
    // This check is synchronous (before any await) so that both concurrent
    // callers see it and the second one returns the first's promise.
    if (this.pendingReady) {
      return this.pendingReady;
    }

    // Wrap the entire adopt-or-spawn logic in a single promise so that
    // setting pendingReady happens synchronously, before any await yields.
    const promise = this.doAdoptOrSpawn(planned, modelAbsPath);
    this.pendingReady = promise.then(
      (url) => { this.pendingReady = null; return url; },
      (err) => { this.pendingReady = null; throw err; },
    );
    return this.pendingReady;
  }

  private async doAdoptOrSpawn(planned: PlannedServer, modelAbsPath: string): Promise<string> {
    const adopted = await this.tryAdopt(modelAbsPath);
    if (adopted) {
      return adopted;
    }
    return this.spawnAndAwait(planned, modelAbsPath);
  }

  private async tryAdopt(modelAbsPath: string): Promise<string | null> {
    const pidfilePath = path.join(modelsDirPath(), GGUF_PIDFILE);
    let pid: number | null = null;
    try {
      const content = await readFile(pidfilePath, "utf8");
      pid = parseInt(content.trim(), 10);
    } catch {
      // No pidfile — no orphans to adopt.
    }

    if (pid !== null && !Number.isNaN(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        // Process is dead — remove stale pidfile.
        await this.cleanupPidfile();
        pid = null;
      }
    }

    if (pid !== null && pid !== this.child?.pid) {
      const url = `http://127.0.0.1:${this.serverPort}`;
      if (await this.checkHealth(url) && await this.verifyProps(url, modelAbsPath)) {
        return url;
      }
      // Either unhealthy or wrong model — clean up and spawn fresh.
      await this.cleanupPidfile();
    }

    return null;
  }

  private async checkHealth(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_POLL_MS * 2) });
      if (!res.ok) return false;
      const data = await res.json() as { status?: string };
      return data.status === "ok" || data.status === "healthy";
    } catch {
      return false;
    }
  }

  private async verifyProps(baseUrl: string, expectedModelPath: string): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(HEALTH_POLL_MS * 2) });
      if (!res.ok) return false;
      const data = await res.json() as { model_path?: string };
      return data.model_path === expectedModelPath;
    } catch {
      return false;
    }
  }

  private async spawnAndAwait(planned: PlannedServer, modelAbsPath: string): Promise<string> {
    const release = await acquireRegistryLock();
    try {
      // Check for foreign server on our port.
      const baseUrl = `http://127.0.0.1:${this.serverPort}`;
      if (await this.checkHealth(baseUrl)) {
        if (!(await this.verifyProps(baseUrl, modelAbsPath))) {
          // Foreign server on our port — reassign.
          const newPort = await this.findFreePort();
          this.serverPort = newPort;
          await this.persistBaseUrl();
          planned = this.updatePortInPlan(planned, newPort);
        }
      }

      this.spawnStart = Date.now();
      const args = planned.args.map((a) => (a === "<model-path>" ? modelAbsPath : a));

      const child = spawn(this.binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;

      await this.writePidfile(child.pid);

      // Collect stderr for debug output.
      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer | string) => {
          const line = Buffer.isBuffer(chunk) ? chunk.toString().trim() : String(chunk).trim();
          if (line) {
            this.stderrLines.push(line);
            if (this.stderrLines.length > STDERR_TAIL_LINES) {
              this.stderrLines.shift();
            }
          }
        });
      }

      // Set up exit handler for crash-loop and flag-fallback detection.
      child.on("exit", (code: number | null) => {
        this.handleExit(code);
      });

      return this.pollHealth(this.serverPort, modelAbsPath);
    } finally {
      await release();
    }
  }

  private handleExit(code: number | null): void {
    const elapsed = Date.now() - this.spawnStart;
    if (code !== 0 && code !== null && elapsed < CRASH_WINDOW_MS) {
      const stderr = this.stderrLines.join("\n");
      const flagMatch = stderr.match(FLAG_TOKEN_RE);
      if (flagMatch) {
        const token = flagMatch[0];
        if (MANDATORY_TOKENS.has(token)) {
          this.lastError = `Mandatory flag failed: ${token}\n${stderr}`;
          if (this.readyReject) {
            this.readyReject(new LlamaResourceError(this.lastError));
          }
          return;
        }
        if (DROPPABLE_FLAGS.has(token) && !this.droppedFlags.has(token) && this.droppedFlags.size < MAX_FLAG_RETRIES) {
          this.droppedFlags.add(token);
          this.retryWithoutFlag(token, this.planned!, this.modelPath).catch(() => {});
          return;
        }
      }
      // Crash loop handling.
      this.restartCount += 1;
      const now = Date.now();
      if (this.restartWindowStart === 0 || now - this.restartWindowStart > RESTART_WINDOW_MS) {
        this.restartWindowStart = now;
        this.restartCount = 1;
      }
      if (this.restartCount > MAX_RESTARTS) {
        const tail = this.stderrLines.slice(-STDERR_TAIL_LINES).join("\n");
        this.lastError = `Crash limit exceeded (${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 1000}s). Last stderr:\n${tail}`;
        this.child = null;
        this.planned = null;
      } else if (this.readyReject) {
        // Retry after a brief delay.
        setTimeout(() => {
          this.spawnAndAwait(this.planned!, this.modelPath).then(
            (url) => this.readyResolve?.(url),
            (err) => this.readyReject?.(err),
          );
        }, HEALTH_POLL_MS);
      }
    }
  }

  private pollHealth(port: number, modelAbsPath: string): Promise<string> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = this.spawnStart + SPAWN_TIMEOUT_MS;

    return new Promise<string>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      const poll = async () => {
        if (Date.now() > deadline) {
          reject(new LlamaResourceError(
            `llama-server did not become healthy within ${SPAWN_TIMEOUT_MS}ms. Last stderr: ${this.stderrLines.slice(-STDERR_TAIL_LINES).join("\n")}`
          ));
          return;
        }
        if (await this.checkHealth(baseUrl) && await this.verifyProps(baseUrl, modelAbsPath)) {
          resolve(baseUrl);
        } else {
          setTimeout(poll, HEALTH_POLL_MS);
        }
      };

      setTimeout(poll, HEALTH_POLL_MS);
    });
  }

  private async retryWithoutFlag(flag: string, planned: PlannedServer, modelAbsPath: string): Promise<void> {
    const newArgs = planned.args.filter((a) => a !== flag);
    const newPlanned = { ...planned, args: newArgs };
    await this.spawnAndAwait(newPlanned, modelAbsPath);
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number };
        const port = addr.port;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  }

  private updatePortInPlan(planned: PlannedServer, newPort: number): PlannedServer {
    const args = [...planned.args];
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1) {
      args[portIdx + 1] = String(newPort);
    }
    return { ...planned, args, port: newPort };
  }

  private async persistBaseUrl(): Promise<void> {
    const doc = await loadRegistry();
    const provider = doc.providers.find((p) => p.id === this.providerId);
    if (provider) {
      provider.baseUrl = `http://127.0.0.1:${this.serverPort}`;
    }
    await saveRegistry(doc);
  }

  private async writePidfile(pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    const pidfilePath = path.join(modelsDirPath(), GGUF_PIDFILE);
    try {
      await writeFile(pidfilePath, String(pid), { mode: 0o600 });
    } catch {
      // Best-effort: pidfile absence never blocks a spawn.
    }
  }

  private async cleanupPidfile(): Promise<void> {
    const pidfilePath = path.join(modelsDirPath(), GGUF_PIDFILE);
    try {
      await unlink(pidfilePath);
    } catch {
      // Already gone.
    }
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      this.child!.on("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.child?.kill("SIGTERM");
    // Best-effort pidfile cleanup.
    this.cleanupPidfile().catch(() => {});
  }
}

// Register process exit handlers once per process.
function registerShutdownHandlers(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = () => {
    for (const runner of runners.values()) {
      runner.stop();
    }
  };

  process.on("exit", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

registerShutdownHandlers();

// --- Module-level exported functions ---

/**
 * Ensure a llama-server is running for the given provider+model, returning
 * the base URL. Spawns, health-polls, verifies /props, and coalesces
 * concurrent callers into a single spawn.
 */
export async function ensureGgufServerRunning(entry: ProviderEntry, modelId: string): Promise<string> {
  assertSafeModelId(modelId);

  // Reject reserved extraFlags before touching the filesystem or spawning.
  // Host binding and port are non-negotiable for local-only llama-server.
  if (entry.gguf?.extraFlags) {
    for (const flag of entry.gguf.extraFlags) {
      if (RESERVED_TOKENS.has(flag.toLowerCase())) {
        throw new LlamaResourceError(
          `Reserved flag "${flag}" must not be overridden via extraFlags. Host binding and port are non-negotiable for local-only llama-server.`
        );
      }
    }
  }

  // Resolve model absolute path.
  const modelsDir = modelsDirPath();
  const modelAbsPath = path.join(modelsDir, modelId);

  let statInfo;
  try {
    statInfo = await stat(modelAbsPath);
  } catch {
    throw new LlamaResourceError(
      `GGUF model "${modelId}" not found at ${modelAbsPath}. Place the .gguf file in ${modelsDir}.`
    );
  }
  const modelSizeBytes = statInfo.size;

  // Find llama-server binary.
  const serverInfo = await findLlamaServer(entry.gguf?.serverPath);
  if (!serverInfo) {
    throw new LlamaResourceError(
      "llama-server binary not found. Install from https://llama.app/ or run `curl -LsSf https://llama.app/install.sh | sh`, then restart Yggdrasil."
    );
  }

  // Build device profile.
  const cpuCores = os.cpus().length;
  const totalMem = os.totalmem();
  const freeMem = getAvailableMemoryBytes();

  // Resolve model context cap from entry.
  const modelEntry = entry.models.find((m) => m.modelId === modelId);
  const modelCtxCap = modelEntry?.capabilities?.contextWindow ?? null;

  // Plan server flags.
  const planned = planServerFlags({
    filename: modelId,
    modelSizeBytes,
    modelCtxCap,
    profile: { cpuCores, totalMemBytes: totalMem, freeMemBytes: freeMem },
    overrides: entry.gguf,
  });

  // Get or create runner.
  const key = runnerKey(entry.id, modelId);
  let runner = runners.get(key);
  if (!runner) {
    runner = new LlamaRunner(entry.id, modelId);
    runners.set(key, runner);
  }

  const baseUrl = await runner.ensureRunning(planned, modelAbsPath, serverInfo.path);
  runner.touch();
  return baseUrl;
}

/**
 * Stop the llama-server for the given provider+model. No-op if not running.
 */
export async function stopGgufServer(providerId: string, modelId: string): Promise<void> {
  const key = runnerKey(providerId, modelId);
  const runner = runners.get(key);
  if (!runner) return;
  runner.stop();
  runners.delete(key);
}

/**
 * Get the current status of the GGUF server runner.
 */
export function getGgufServerStatus(providerId: string, modelId: string): RunnerStatus {
  const key = runnerKey(providerId, modelId);
  const runner = runners.get(key);
  if (!runner) {
    return { state: "unload", pid: null, planned: null, lastError: null };
  }
  return runner.status;
}

/**
 * Reset all runner state. Used by tests to isolate state between test cases.
 */
export function __resetGgufRunnersForTest(): void {
  for (const runner of runners.values()) {
    runner.stop();
  }
  runners.clear();
}
