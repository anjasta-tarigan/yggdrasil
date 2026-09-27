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

const FS_CALL =
  /\b(?:fs|fsp|fsPromises)\.(?:readFile|writeFile|appendFile|mkdir|stat|lstat|access|rm|unlink|rename|copyFile|readdir|open|readFileSync|writeFileSync|mkdirSync|statSync|lstatSync|existsSync|rmSync|unlinkSync|renameSync|readdirSync|openSync)\s*(?:Sync)?\s*\(/;

/**
 * Identifiers assigned from a STATICALLY-resolvable data path.
 *
 * Turbopack can only trace a path it can resolve at build time: one built from
 * `process.cwd()` or a bare `"data/..."` literal. A path built from a runtime
 * variable (e.g. `path.join(baseDir, "data", "cache")`) is not traceable and
 * must not be flagged — that would be a false positive.
 */
function collectDataPathIdentifiers(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    const staticallyResolvable =
      /path\.(resolve|join)\([^)]*process\.cwd\(\)/.test(line) &&
      /["']data["']/.test(line) ||
      /["']data\/[a-z]/.test(line);
    if (!staticallyResolvable) continue;
    const m = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/** Does the fs call on this line take a statically-resolvable data path? */
function fsCallOnDataPath(line: string, dataIds: Set<string>): boolean {
  if (!FS_CALL.test(line)) return false;
  // Bare "data/..." literal in the argument list.
  if (/["']data\/[a-z]/.test(line)) return true;
  // A known data-path identifier referenced in the call.
  for (const id of dataIds) {
    if (new RegExp(`\\b${id}\\b`).test(line)) return true;
  }
  return false;
}

describe("Turbopack data-path markers", () => {
  it("every fs call on a data path carries a turbopackIgnore marker", async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const lines = (await fs.readFile(file, "utf8")).split("\n");
      const dataIds = collectDataPathIdentifiers(lines);
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (line.includes("turbopackIgnore")) return;
        if (!fsCallOnDataPath(line, dataIds)) return;
        offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${trimmed}`);
      });
    }

    expect(
      offenders,
      `Missing turbopackIgnore marker on fs call:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
