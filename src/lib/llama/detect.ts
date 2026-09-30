// src/lib/llama/detect.ts
import * as childProcess from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  LlamaResourceError,
  MIN_LLAMA_SERVER_BUILD,
  GGUF_MODELS_DIRNAME,
  type GgufFileEntry,
  type LlamaServerInfo,
} from "./types";
import { usableMemoryBytes, residentOverheadBytes } from "./resource-planner";
import { getAvailableMemoryBytes } from "@/lib/system-stats";

const VERSION_RE = /(?:version:\s*|b)(\d{3,5})/;

async function runVersion(binary: string): Promise<string> {
  // A version probe must never throw: any failure → "" (warn-and-proceed).
  // Direct 3-arg execFile(file, args, callback) — no options object — matching
  // the callback shape the unit tests assert on.
  return new Promise((resolve) => {
    childProcess.execFile(binary, ["--version"], (error, stdout, stderr) => {
      if (error) return resolve("");
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`);
    });
  });
}

async function binaryOnPath(name: string): Promise<string | null> {
  const probe = process.platform === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    childProcess.execFile(probe, [name], (error, stdout) => {
      if (error) return resolve(null);
      const first = String(stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first ?? null);
    });
  });
}

/**
 * Locate the llama-server binary. configuredPath (gguf.serverPath) wins when
 * the file exists; otherwise PATH is scanned. Version below the minimum
 * rejects loudly; unparseable version warns-and-proceeds (version: null) —
 * the runner's unknown-flag fallback protects droppable flags at startup.
 */
export async function findLlamaServer(configuredPath?: string): Promise<LlamaServerInfo | null> {
  let binary: string | null = null;
  if (configuredPath) {
    try {
      const st = await stat(configuredPath);
      if (st.isFile()) binary = configuredPath;
    } catch {
      binary = null; // missing configured path falls through to PATH scan
    }
  }
  binary ??= await binaryOnPath("llama-server");
  if (!binary) return null;

  const output = await runVersion(binary);
  const m = output.match(VERSION_RE);
  const version = m ? parseInt(m[1], 10) : null;
  if (version !== null && version < MIN_LLAMA_SERVER_BUILD) {
    throw new LlamaResourceError(
      `llama-server build ${version} found, but build ${MIN_LLAMA_SERVER_BUILD}+ is required ` +
        `for --jinja support. Update with \`curl -LsSf https://llama.app/install.sh | sh\`.`
    );
  }
  return { path: binary, version };
}

/** Absolute path of the user-managed GGUF model directory. */
export function modelsDirPath(): string {
  return process.env.GGUF_MODELS_DIR
    ? path.resolve(process.env.GGUF_MODELS_DIR)
    : path.resolve(process.cwd(), "data", GGUF_MODELS_DIRNAME);
}

/**
 * Scan the GGUF model directory (flat: nested files ignored — modelId is a
 * bare filename). Sorted fits-current-memory first, then by name.
 */
export async function scanGgufModels(modelsDir?: string): Promise<GgufFileEntry[]> {
  const dir = modelsDir ?? modelsDirPath();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let freeMem: number;
  try {
    freeMem = getAvailableMemoryBytes();
  } catch {
    freeMem = 0; // unknown memory → every file reports fitsMemory: false, never a throw
  }
  let usable = 0;
  try {
    usable = usableMemoryBytes(freeMem);
  } catch {
    usable = 0;
  }
  const entries: GgufFileEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".gguf")) continue;
    if (path.basename(name) !== name) continue;
    let sizeBytes = 0;
    try {
      const st = await stat(path.join(dir, name));
      if (!st.isFile()) continue;
      sizeBytes = st.size;
    } catch {
      continue; // raced deletion between readdir and stat — skip, don't fail the scan
    }
    entries.push({
      filename: name,
      path: path.join(dir, name),
      sizeBytes,
      fitsMemory: usable > 0 && residentOverheadBytes(sizeBytes) <= usable,
    });
  }
  return entries.sort(
    (a, b) => Number(b.fitsMemory) - Number(a.fitsMemory) || a.filename.localeCompare(b.filename)
  );
}
