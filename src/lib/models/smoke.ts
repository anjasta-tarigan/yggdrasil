/**
 * Isolated child-process smoke test orchestrator.
 *
 * Spawns src/lib/models/smoke-worker.mjs in a separate OS process via
 * child_process.fork(). Native crashes (SIGSEGV, SIGABRT, SIGFPE) kill only
 * the child — the host Next.js server survives.
 *
 * Why fork() and not worker_threads: worker_threads share the process address
 * space and signal handlers. A native abort() in a worker thread terminates
 * the entire host process. Only an OS process boundary provides isolation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { syslog } from "@/lib/observability/log-store";

export class ModelUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnusableError";
  }
}

export interface SmokeTestResult {
  ok: boolean;
  outputDims?: number[];
  error?: string;
  isCrash?: boolean;
}

function resolveWorkerPath(): string {
  // 1. If import.meta.dirname is defined (Node 20.11+ native ESM)
  const meta = import.meta as { dirname?: string; url?: string };
  if (typeof meta.dirname === "string") {
    const candidate = path.resolve(meta.dirname, "./smoke-worker.mjs");
    if (fs.existsSync(candidate)) return candidate;
  }
  // 2. If import.meta.url is defined
  if (typeof meta.url === "string") {
    try {
      const candidate = path.resolve(path.dirname(fileURLToPath(meta.url)), "./smoke-worker.mjs");
      if (fs.existsSync(candidate)) return candidate;
    } catch (err) {
      syslog("debug", "smoke", `Candidate worker resolution via import.meta.url failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // 3. Bundled runtime (Next.js server): relative to process.cwd()
  const fromCwd = path.resolve(process.cwd(), "src/lib/models/smoke-worker.mjs");
  if (fs.existsSync(fromCwd)) return fromCwd;

  return fromCwd;
}

/**
 * Run a smoke test on the ONNX model at `modelPath` in an isolated child
 * process. Returns a structured result that never throws into the caller.
 *
 * @param modelPath  Absolute path to the .onnx file to probe.
 * @param timeoutMs  Hard timeout (default 30 s). Kills the child with SIGKILL.
 */
export async function runSmokeTest(
  modelPath: string,
  timeoutMs: number = 30_000,
): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    const workerPath = resolveWorkerPath();
    // Strip inspect/debug flags to avoid EADDRINUSE on the child's debugger
    // port, but preserve other runtime flags (e.g. --max-old-space-size).
    const cleanExecArgv = process.execArgv.filter(
      (arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"),
    );

    const child: ChildProcess = spawn(
      process.execPath,
      [...cleanExecArgv, workerPath, modelPath],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );

    let settled = false;
    let workerResult: SmokeTestResult | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch (err) {
        syslog("debug", "smoke", `child.kill SIGKILL: ${err instanceof Error ? err.message : String(err)}`);
      }
      resolve({ ok: false, error: `Smoke test timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);

    child.on("message", (msg: { ok: boolean; outputDims?: number[]; error?: string }) => {
      if (settled) return;
      workerResult = msg;
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // A signal or non-zero exit without a prior IPC message means a
      // native crash (SIGSEGV, SIGABRT, SIGFPE) or uncaught abort.
      if (signal || (code !== null && code !== 0 && !workerResult)) {
        resolve({
          ok: false,
          error: `Native crash or abnormal termination during model initialization: ${
            signal ? `signal ${signal}` : `exit code ${code}`
          }`,
          isCrash: true,
        });
        return;
      }

      if (workerResult) {
        resolve(workerResult);
      } else {
        // Exited cleanly with code 0 but no IPC message (should not happen
        // if the worker uses process.send callback before exit).
        resolve({ ok: false, error: `Process exited with code ${code}` });
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}
