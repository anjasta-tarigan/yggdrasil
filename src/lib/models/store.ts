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
import { CANONICAL_EMBEDDING_DIR } from "@/lib/memory/embeddings";
import { CANONICAL_RERANKER_DIR } from "@/lib/memory/reranker";

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
}

/**
 * Resolve the canonical base directory for a model kind.
 * `customBase` allows tests (and callers) to redirect to a temp dir.
 */
export function getBaseDirForKind(kind: ModelKind, customBase?: string): string {
  if (customBase) return path.join(customBase, kind);
  return kind === "embedding" ? CANONICAL_EMBEDDING_DIR : CANONICAL_RERANKER_DIR;
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
  } catch {
    // Missing or corrupt manifest — treat as "not a managed model directory".
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
    } catch {
      // No external data file — graph is self-contained.
    }
    return total;
  } catch {
    // File vanished or stat failed.
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
        } catch {
          // Best-effort: parent cleanup must not block sibling sweeps.
        }
      } else {
        // Inside a manifested directory, remove stale partial downloads.
        for (const fname of fs.readdirSync(dirPath)) {
          if (fname.endsWith(".part")) {
            try {
              fs.unlinkSync(path.join(dirPath, fname));
            } catch {
              // Best-effort: part file may be locked or already removed.
            }
          }
        }
      }
    }
  } catch {
    // readdirSync failed (permissions, I/O error) — stop the sweep.
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
          });
        }
      }
    }
  } catch {
    // readdirSync or iteration failed — return whatever was collected.
    return results;
  }

  return results.sort((a, b) => a.filename.localeCompare(b.filename));
}
