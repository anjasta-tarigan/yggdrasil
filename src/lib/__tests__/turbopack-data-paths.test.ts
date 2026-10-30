import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Static guard for the production build's Turbopack data-directory tracing.
 *
 * In an installed layout `app/data` is a symlink to the canonical
 * `~/.yggdrasil/data` (outside the app root). Turbopack statically traces a
 * filesystem call whose argument resolves to a path under `data/`, follows the
 * symlink, and aborts the build with "Symlink [project]/data/... is invalid,
 * it points out of the filesystem root". Such calls are marked with a
 * `turbopackIgnore: true` comment so the tracer leaves them alone.
 *
 * `yggdrasil update` builds with the symlink already present, so a missing
 * marker makes every update fail. The marker must sit on the fs CALL argument
 * (not merely on the constant's definition) — Turbopack traces the call site.
 *
 * Scope: the bundled server source. The tsx-run CLI and client components are
 * not part of the Next/Turbopack build and are excluded.
 */

const SRC_ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXCLUDED_DIRS = ["node_modules", "__tests__", "cli", "components"];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSourceFiles(full)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Every fs function name that can appear as a bare import. */
const FS_FUNCTION_NAMES = [
  "readFile", "writeFile", "appendFile", "mkdir", "stat", "lstat", "access",
  "rm", "unlink", "rename", "copyFile", "readdir", "open",
  "readFileSync", "writeFileSync", "mkdirSync", "statSync", "lstatSync",
  "existsSync", "rmSync", "unlinkSync", "renameSync", "readdirSync", "openSync",
];

const FS_CALL_PREFIXED = new RegExp(
  `\\b(?:fs|fsp|fsPromises)\\.(?:${FS_FUNCTION_NAMES.join("|")})\\s*(?:Sync)?\\s*\\(`
);

/**
 * Identifiers assigned from a STATICALLY-resolvable data path.
 *
 * Turbopack can only trace a path it can resolve at build time: one built from
 * `process.cwd()` or a bare `"data/..."` literal. A path built from a runtime
 * variable (e.g. `path.join(baseDir, "data", "cache")`) is not traceable and
 * must not be flagged — that would be a false positive.
 *
 * Also collects identifiers assigned from a call to a known data-path-producing
 * function (e.g. `modelsDirPath()`), since those resolve to a data path at
 * runtime and therefore must be marked.
 */
const DATA_PATH_RESOLVERS = new Set(["modelsDirPath", "resolveInstallPaths"]);

function collectDataPathIdentifiers(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    const staticallyResolvable =
      /path\.(resolve|join)\([^)]*process\.cwd\(\)/.test(line) &&
      /["']data["']/.test(line) ||
      /["']data\/[a-z]/.test(line);
    if (staticallyResolvable) {
      const m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (m) ids.add(m[1]);
    }
    // Identifier assigned from a known data-path-resolving function call.
    for (const fn of DATA_PATH_RESOLVERS) {
      const re = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${fn}\\s*\\(`);
      const m = line.match(re);
      if (m) ids.add(m[1]);
    }
  }
  return ids;
}

/** Collect bare names imported from `node:fs` or `node:fs/promises`. */
function collectBareFsImports(lines: string[]): Set<string> {
  const bare = new Set<string>();
  for (const line of lines) {
    const m = line.match(
      /import\s*\{([^}]+)}\s*from\s*["']node:fs(?:\/promises)?["']/
    );
    if (!m) continue;
    const fns = m[1]
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/)[0].replace(/\s+/g, ""))
      .map((n) => n.replace(/^.*\*/, "")); // strip "* as fsPromises" → "fsPromises"
    for (const fn of fns) {
      if (FS_FUNCTION_NAMES.includes(fn)) bare.add(fn);
    }
  }
  return bare;
}

/** Build a regex that matches either prefixed (fs.stat) or bare (stat) calls. */
function makeBareFsCallRegex(bareImports: Set<string>): RegExp | null {
  if (bareImports.size === 0) return null;
  const pattern = Array.from(bareImports)
    .sort((a, b) => b.length - a.length)
    .map((fn) => fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`\\b(?:${pattern})\\s*(?:Sync)?\\s*\\(`);
}

/** Does the fs call on this line take a statically-resolvable data path? */
function fsCallOnDataPath(
  line: string,
  dataIds: Set<string>,
  bareFsImports: Set<string>
): boolean {
  const bareRegex = makeBareFsCallRegex(bareFsImports);
  const isFsCall =
    FS_CALL_PREFIXED.test(line) || (bareRegex !== null && bareRegex.test(line));
  if (!isFsCall) return false;
  // Bare "data/..." literal in the argument list.
  if (/["']data\/[a-z]/.test(line)) return true;
  // A known data-path identifier referenced in the call.
  for (const id of dataIds) {
    if (new RegExp(`\\b${id}\\b`).test(line)) return true;
  }
  return false;
}

/**
 * Does the path.resolve/path.join on this line take a statically-resolvable
 * data path?
 *
 * Turbopack only traces `DirAssetReference`s for paths it can resolve at
 * build time — i.e. path.resolve/process.cwd() + "data/…" literals.
 * path.join/resolve of a runtime variable (e.g. ggufDir) is NOT traceable
 * and therefore not a build risk.
 */
function pathCallOnDataPath(
  line: string,
  _dataIds: Set<string>,
  _bareFsImports: Set<string>
): boolean {
  if (!/path\.(resolve|join)\s*\(/.test(line)) return false;
  // Must reference process.cwd() — only that + "data" is statically resolvable
  // by Turbopack (process.cwd() is known at build time). Runtime variables
  // passed to path.join are not traceable and not a build risk.
  if (!/process\.cwd\(\)/.test(line)) return false;
  // Must include a "data"-rooted literal.
  if (/["']data["']/.test(line) || /["']data\/[a-z]/.test(line)) return true;
  return false;
}

describe("Turbopack data-path markers", () => {
  it("every fs call on a data path carries a turbopackIgnore marker", async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const lines = (await fs.readFile(file, "utf8")).split("\n");
      const dataIds = collectDataPathIdentifiers(lines);
      const bareFsImports = collectBareFsImports(lines);
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (line.includes("turbopackIgnore")) return;
        if (!fsCallOnDataPath(line, dataIds, bareFsImports)) return;
        offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${trimmed}`);
      });
    }

    expect(
      offenders,
      `Missing turbopackIgnore marker on fs call:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every path.resolve/path.join on a data path carries a turbopackIgnore marker", async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const lines = (await fs.readFile(file, "utf8")).split("\n");
      const dataIds = collectDataPathIdentifiers(lines);
      const bareFsImports = collectBareFsImports(lines);
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (line.includes("turbopackIgnore")) return;
        // Turbopack statically resolves path.resolve/path.join with
        // process.cwd() and "data/…" literals, following symlinks. Without
        // turbopackIgnore it traces into data/models/... and fails on
        // "points out of the filesystem root".
        if (!pathCallOnDataPath(line, dataIds, bareFsImports)) return;
        offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${trimmed}`);
      });
    }

    expect(
      offenders,
      `Missing turbopackIgnore marker on path.resolve/path.join:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
