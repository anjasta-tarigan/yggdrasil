/**
 * Model Store: directory layout, manifest integrity, and orphan sweep.
 *
 * All model files land strictly in `data/models/<kind>/<org>--<name>/`
 * (Rule 06: Isolation Invariant). A `manifest.json` written last is the
 * completion gate — discovery requires a valid manifest, so a half-finished
 * install never appears in the dropdown.
 */

import fs from "node:fs";
import path from "node:path";
import { sanitizeSkillFilePath } from "@/lib/skills/config";
import type { ModelKind } from "./types";
export type { ModelKind };
import { CANONICAL_EMBEDDING_DIR } from "@/lib/memory/embeddings";
import { CANONICAL_RERANKER_DIR } from "@/lib/memory/reranker";
import { releaseOnnxSession } from "@/lib/memory/onnx-session";
import { syslog } from "@/lib/observability/log-store";

/** Minimum byte length for an ONNX model file (~10 MB) to reject stubs/404s. */
const MIN_VALID_MODEL_SIZE = 10 * 1024 * 1024;

export interface ModelManifest {
  schemaVersion: 1;
  repo: string;
  kind: ModelKind;
  variant: string;
  files: string[];
  sizeBytes: number;
  poolingMode?: string;
  installedAt: string;
}

export interface DiscoveredModel {
  filename: string;
  path: string;
  repo?: string;
  sizeBytes: number;
  isLegacy?: boolean;
  poolingMode?: string;
}

const DEFAULT_EMBEDDING_DIR = path.resolve(/* turbopackIgnore: true */ process.cwd(), "data/models/embedding");
const DEFAULT_RERANKER_DIR = path.resolve(/* turbopackIgnore: true */ process.cwd(), "data/models/reranker");

/**
 * Resolve the canonical base directory for a model kind.
 * `customBase` allows tests (and callers) to redirect to a temp dir.
 */
export function getBaseDirForKind(kind: ModelKind, customBase?: string): string {
  if (customBase) return path.join(customBase, kind);
  if (kind === "embedding") {
    return CANONICAL_EMBEDDING_DIR || DEFAULT_EMBEDDING_DIR;
  }
  return CANONICAL_RERANKER_DIR || DEFAULT_RERANKER_DIR;
}

/**
 * Compute the directory path for a model repo, flattening the org/name
 * separator into `--` so the model sits at depth 1 (spec §2.2).
 *
 * `sanitizeSkillFilePath` is applied first to reject path-traversal attempts
 * (Rule 04): no `..` segments, no absolute paths, no backslashes.
 */
export function getModelDir(kind: ModelKind, repo: string, customBase?: string): string {
  const sanitized = sanitizeSkillFilePath(repo);
  if (!sanitized) {
    throw new Error(`Invalid model repo path (rejected by path sanitizer): ${repo}`);
  }
  const parts = sanitized.split("/");
  const dirName = parts.length === 2 ? `${parts[0]}--${parts[1]}` : parts.join("--");
  return path.join(getBaseDirForKind(kind, customBase), dirName);
}

/**
 * Persist a manifest as the final step of a successful install.
 * Written last so a crash mid-install leaves no complete manifest.
 */
export function writeManifest(modelDir: string, manifest: ModelManifest): void {
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(
    path.join(modelDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

/**
 * Read a manifest from a model directory. Returns `null` if the file is
 * missing or corrupt — callers treat `null` as "not installed".
 */
export function readManifest(modelDir: string): ModelManifest | null {
  try {
    const raw = fs.readFileSync(path.join(modelDir, "manifest.json"), "utf8");
    return JSON.parse(raw) as ModelManifest;
  } catch (err) {
    syslog("debug", "store", `readManifest ${modelDir}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Compute the effective byte size of an ONNX model, including its
 * external-data sibling file (`<name>.onnx_data`) when present (ONNX
 * external-data format). This prevents large models with external weights
 * from being rejected as stubs when discovered as legacy flat files.
 */
function effectiveModelSize(filePath: string): number {
  try {
    let total = fs.statSync(filePath).size;
    try {
      total += fs.statSync(`${filePath}_data`).size;
    } catch (err) {
      syslog("debug", "store", `no external data file for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return total;
  } catch (err) {
    syslog("debug", "store", `effectiveModelSize stat failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Remove directories that have no manifest and no active install job, plus
 * any stale `*.part` files inside manifested directories.
 *
 * @param activeJobDirs Set of absolute directory paths currently being
 *   written by an in-flight install job — these are never swept.
 */
export function sweepOrphans(kind: ModelKind, activeJobDirs: Set<string>, customBase?: string): void {
  const base = getBaseDirForKind(kind, customBase);
  if (!fs.existsSync(base)) return;

  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(base, entry.name);
      if (activeJobDirs.has(dirPath)) continue;

      const manifest = readManifest(dirPath);
      if (!manifest) {
        // Unmanifested directory with no active job → purge.
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
        } catch (err) {
          syslog("debug", "store", `sweepOrphans rmSync ${dirPath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // Inside a manifested directory, remove stale partial downloads.
        for (const fname of fs.readdirSync(dirPath)) {
          if (fname.endsWith(".part")) {
            try {
              fs.unlinkSync(path.join(dirPath, fname));
            } catch (err) {
              syslog("debug", "store", `sweepOrphans unlink ${fname}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }
  } catch (err) {
    syslog("debug", "store", `sweepOrphans readdirSync: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Discover all managed models of `kind` in the canonical (or custom) base.
 *
 * - **Manifested subdirectories**: one level deep (`<dir>/manifest.json` +
 *   `<dir>/<variant>`), with the manifest's `repo` and `sizeBytes` carried
 *   through.
 * - **Legacy flat files**: top-level `*.onnx` files with no manifest, marked
 *   `isLegacy: true`. Size includes external-data siblings for BGE-style
 *   exports.
 *
 * Returns `[]` on any I/O error (mirrors the old `discoverEmbeddingModels`
 * contract — a missing directory is not a crash).
 */
export function discoverModels(kind: ModelKind, customBase?: string): DiscoveredModel[] {
  const base = getBaseDirForKind(kind, customBase);
  if (!fs.existsSync(base)) return [];

  const results: DiscoveredModel[] = [];

  try {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".onnx")) {
        // Legacy flat file directly in canonical dir
        const filePath = path.join(base, entry.name);
        const size = effectiveModelSize(filePath);
        if (size >= MIN_VALID_MODEL_SIZE) {
          results.push({
            filename: entry.name,
            path: filePath,
            sizeBytes: size,
            isLegacy: true,
          });
        }
      } else if (entry.isDirectory()) {
        const modelDir = path.join(base, entry.name);
        const manifest = readManifest(modelDir);
        if (!manifest) continue;
        const modelFilePath = path.join(modelDir, manifest.variant);
        if (fs.existsSync(modelFilePath)) {
          results.push({
            filename: `${entry.name}/${manifest.variant}`,
            path: modelFilePath,
            repo: manifest.repo,
            sizeBytes: manifest.sizeBytes,
            poolingMode: manifest.poolingMode,
          });
        }
      }
    }
  } catch (err) {
    // readdirSync or iteration failed — return whatever was collected.
    syslog("debug", "store", `discoverModels (${kind}) directory read failed: ${err instanceof Error ? err.message : String(err)}`);
    return results;
  }

  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}

export interface DeleteModelResult {
  success: boolean;
  error?: string;
  freedBytes?: number;
}

/**
 * Delete an installed model cleanly and completely.
 *
 * Releases any active ONNX session holding the model file open (preventing EBUSY on Windows)
 * and purges the entire directory (manifest, weights, tokenizer, config) or flat legacy file.
 */
export function deleteModel(
  kind: ModelKind,
  target: string,
  customBase?: string
): DeleteModelResult {
  const base = path.resolve(getBaseDirForKind(kind, customBase));
  if (!target || typeof target !== "string") {
    throw new Error("Invalid model identifier: target must be a non-empty string");
  }

  // Security: reject path traversal
  if (target.includes("..") || path.isAbsolute(target)) {
    throw new Error(`Invalid model target (path traversal detected): ${target}`);
  }

  const normalized = target.replace(/\\/g, "/").trim();
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Error("Invalid model target: empty path");
  }

  // Determine candidate directory path or file path
  let candidateDir: string | null = null;
  let candidateFile: string | null = null;

  if (segments.length >= 2 && !segments[0].includes("--")) {
    // Repo format: "org/model-name" -> "org--model-name"
    const dirName = `${segments[0]}--${segments[1]}`;
    candidateDir = path.join(base, dirName);
  } else {
    // Either "org--model-name/model.onnx" or "org--model-name" or "legacy.onnx"
    const first = segments[0];
    const resolvedFirst = path.join(base, first);
    try {
      const stat = fs.statSync(resolvedFirst);
      if (stat.isDirectory()) {
        candidateDir = resolvedFirst;
      } else if (stat.isFile()) {
        candidateFile = resolvedFirst;
      }
    } catch (err) {
      syslog("debug", "store", `Error: ${err instanceof Error ? err.message : String(err)}`);
      // File/dir doesn't exist directly, check if target as a whole is a file
      const directResolved = path.join(base, normalized);
      if (fs.existsSync(directResolved)) {
        candidateFile = directResolved;
      }
    }
  }

  // Verify path containment within base directory
  const checkContainment = (p: string) => {
    const resolved = path.resolve(p);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error(`Security Violation: Path "${resolved}" escapes base "${base}"`);
    }
    return resolved;
  };

  if (candidateDir && fs.existsSync(/* turbopackIgnore: true */ candidateDir)) {
    const dirToDelete = checkContainment(candidateDir);
    let freedBytes = 0;
    try {
      const manifest = readManifest(dirToDelete);
      freedBytes = manifest?.sizeBytes ?? 0;
    } catch (err) {
      syslog("debug", "store", `Error: ${err instanceof Error ? err.message : String(err)}`);
      // non-fatal
    }

    try {
      // Release session first so file lock is freed on Windows
      void releaseOnnxSession(kind);
      fs.rmSync(dirToDelete, { recursive: true, force: true });
      syslog("info", "store", `Model directory deleted cleanly: ${dirToDelete}`);
      return { success: true, freedBytes };
    } catch (err) {
      syslog("error", "store", `Failed to delete model directory ${dirToDelete}: ${err instanceof Error ? err.message : String(err)}`);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (candidateFile && fs.existsSync(/* turbopackIgnore: true */ candidateFile)) {
    const fileToDelete = checkContainment(candidateFile);
    let freedBytes = 0;
    try {
      freedBytes = fs.statSync(/* turbopackIgnore: true */ fileToDelete).size;
    } catch (err) {
      syslog("debug", "store", `Error: ${err instanceof Error ? err.message : String(err)}`);
      // ignore
    }

    try {
      void releaseOnnxSession(kind);
      fs.unlinkSync(fileToDelete);
      // If companion external data file exists, purge it too
      const dataFile = `${fileToDelete}_data`;
      if (fs.existsSync(dataFile)) {
        try {
          freedBytes += fs.statSync(dataFile).size;
          fs.unlinkSync(dataFile);
        } catch (err) {
          syslog("debug", "store", `Error: ${err instanceof Error ? err.message : String(err)}`);
          // ignore
        }
      }
      syslog("info", "store", `Legacy model file deleted cleanly: ${fileToDelete}`);
      return { success: true, freedBytes };
    } catch (err) {
      syslog("error", "store", `Failed to delete model file ${fileToDelete}: ${err instanceof Error ? err.message : String(err)}`);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return { success: false, error: `Model not found: ${target}` };
}
