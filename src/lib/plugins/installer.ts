/**
 * Plugin installer — resolves a marketplace plugin entry `source` into
 * a file tree and writes it under data/plugins/<marketplace>/<plugin>/.
 *
 * Supported source types (Claude Code marketplace format):
 *  - relative path ("./plugins/foo") inside the marketplace repo
 *  - { source: "github", repo, ref? }
 *  - { source: "git-subdir", url, path, ref? }  (github.com URLs only)
 *  - { source: "url", url, ref? }               (github.com URLs only)
 *  - { source: "archive", url }                 (HTTPS zip, allowlisted hosts)
 * Unsupported (reported, never executed): npm, command, non-GitHub git.
 */

import fs from "node:fs";
import path from "node:path";
import {
  fetchGithubRawFile,
  parseGithubRepoRef,
  type GithubRepoRef,
} from "@/lib/skills/registries/github";
import {
  extractZipToFileMap,
  fetchBuffer,
  fetchJson,
  GuardedFetchOptions,
  RegistryError,
} from "@/lib/skills/registries/http";
import type { MarketplaceSource, PluginSourceSpec } from "./marketplace";

/** Max files / bytes for one installed plugin. */
export const MAX_PLUGIN_FILES = 500;
export const MAX_PLUGIN_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024;

export interface PluginFileTree {
  /** path → content (relative POSIX paths, traversal-checked). */
  files: Map<string, string>;
}

export type ResolveResult =
  | { ok: true; tree: PluginFileTree }
  | { ok: false; error: string; unsupported?: boolean };

interface GitTreeResponse {
  tree?: Array<{ path: string; type: string }>;
  truncated?: boolean;
}

/** Fetch a whole GitHub subtree (or repo root) into a file map. */
async function fetchGithubSubtree(
  ref: GithubRepoRef,
  subpath: string,
  options: GuardedFetchOptions
): Promise<Map<string, string>> {
  const gitRef = ref.ref ?? "HEAD";
  const data = await fetchJson<GitTreeResponse>(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(gitRef)}?recursive=1`,
    options
  );
  if (!Array.isArray(data.tree)) {
    throw new RegistryError("GitHub trees API returned an unexpected payload.");
  }
  if (data.truncated) {
    throw new RegistryError("Repository tree too large to install from.");
  }

  const prefix = subpath ? subpath.replace(/\/+$/, "") + "/" : "";
  const wanted = data.tree.filter(
    (node) => node.type === "blob" && (prefix ? node.path.startsWith(prefix) : true)
  );
  if (wanted.length === 0) {
    throw new RegistryError(
      `No files found ${prefix ? `under '${subpath}' ` : ""}in ${ref.owner}/${ref.repo}.`
    );
  }
  if (wanted.length > MAX_PLUGIN_FILES) {
    throw new RegistryError(`Plugin has too many files (max ${MAX_PLUGIN_FILES}).`);
  }

  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const node of wanted) {
    const content = await fetchGithubRawFile(ref, node.path, {
      ...options,
      maxBytes: MAX_PLUGIN_FILE_BYTES,
    });
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) {
      throw new RegistryError("Plugin exceeds the total size cap.");
    }
    files.set(prefix ? node.path.slice(prefix.length) : node.path, content);
  }
  return files;
}

/**
 * Resolve one plugin entry source into its file tree.
 * `marketplaceSource` is needed for relative-path sources.
 */
export async function resolvePluginSource(
  source: PluginSourceSpec,
  marketplaceSource: MarketplaceSource,
  options: GuardedFetchOptions = {}
): Promise<ResolveResult> {
  // Relative path inside the marketplace repo.
  if (typeof source === "string") {
    if (!source.startsWith("./")) {
      return { ok: false, error: `Unsupported string source: ${source}`, unsupported: true };
    }
    if (marketplaceSource.kind !== "github") {
      return {
        ok: false,
        error: "Relative plugin sources need a GitHub-hosted marketplace.",
        unsupported: true,
      };
    }
    const subpath = source.slice(2).replace(/\/+$/, "");
    try {
      const files = await fetchGithubSubtree(
        {
          owner: marketplaceSource.owner,
          repo: marketplaceSource.repo,
          ref: marketplaceSource.ref,
        },
        subpath,
        options
      );
      return { ok: true, tree: { files } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const kind = source.source;

  if (kind === "github") {
    const ref = parseGithubRepoRef(source.repo ?? "");
    if (!ref) return { ok: false, error: `Bad github source repo: ${source.repo}` };
    ref.ref = source.sha ?? source.ref ?? ref.ref;
    const subpath = (source.path ?? ref.subpath ?? "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    try {
      const files = await fetchGithubSubtree(ref, subpath, options);
      return { ok: true, tree: { files } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (kind === "git-subdir" || kind === "url") {
    const url = source.url ?? "";
    const ref = parseGithubRepoRef(url);
    if (!ref) {
      return {
        ok: false,
        error: `Only github.com git sources are supported in this build (got ${url || "none"}).`,
        unsupported: true,
      };
    }
    ref.ref = source.sha ?? source.ref ?? ref.ref;
    const rawSubpath = kind === "git-subdir" ? (source.path ?? "") : (ref.subpath ?? "");
    const subpath = rawSubpath.replace(/^\.\//, "").replace(/\/+$/, "");
    try {
      const files = await fetchGithubSubtree(
        { owner: ref.owner, repo: ref.repo, ref: ref.ref },
        subpath,
        options
      );
      return { ok: true, tree: { files } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (kind === "archive") {
    const url = source.url ?? "";
    try {
      const bytes = await fetchBuffer(url, {
        ...options,
        maxBytes: MAX_PLUGIN_TOTAL_BYTES,
      });
      const extracted = extractZipToFileMap(bytes, {
        maxFiles: MAX_PLUGIN_FILES,
        maxFileBytes: MAX_PLUGIN_FILE_BYTES,
        maxTotalBytes: MAX_PLUGIN_TOTAL_BYTES,
      });
      if (!extracted.ok) return { ok: false, error: extracted.error };
      return { ok: true, tree: { files: extracted.files } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (kind === "npm" || kind === "command") {
    return {
      ok: false,
      error: `Plugin source type '${kind}' is not supported (security policy: no package installs, no commands).`,
      unsupported: true,
    };
  }

  return {
    ok: false,
    error: `Unrecognized plugin source type: ${String(kind)}`,
    unsupported: true,
  };
}

export interface WritePluginOptions {
  /** Override plugins root (tests). */
  root?: string;
}

/** Root directory holding one folder per marketplace. */
export function pluginsRoot(options: WritePluginOptions = {}): string {
  return (
    options.root ??
    process.env.PLUGINS_DIR ??
    path.resolve(process.cwd(), "data", "plugins")
  );
}

/**
 * Directory of one installed plugin (no existence check).
 *
 * The plugins root is intentionally configurable (test injection +
 * PLUGINS_DIR env override), so Turbopack cannot statically scope the
 * fs calls in this module; they carry turbopackIgnore markers to keep
 * the build warning-free (this app is self-hosted, so whole-project
 * tracing is harmless).
 */
export function pluginDir(
  marketplaceName: string,
  pluginName: string,
  options: WritePluginOptions = {}
): string {
  return path.join(
    /*turbopackIgnore: true*/ pluginsRoot(options),
    marketplaceName,
    pluginName
  );
}

/**
 * Write a resolved file tree to the plugin directory atomically
 * (temp dir → rename). Returns the installed file count.
 */
export function writePluginTree(
  marketplaceName: string,
  pluginName: string,
  tree: PluginFileTree,
  options: WritePluginOptions = {}
): number {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(marketplaceName) || !/^[a-z0-9][a-z0-9._-]*$/i.test(pluginName)) {
    throw new RegistryError("Invalid marketplace or plugin name for filesystem use.");
  }
  const root = pluginsRoot(options);
  const dest = pluginDir(marketplaceName, pluginName, options);
  const tmp = path.join(
    /*turbopackIgnore: true*/ root,
    `.tmp-${pluginName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  );

  fs.mkdirSync(/*turbopackIgnore: true*/ tmp, { recursive: true });
  try {
    let count = 0;
    for (const [relPath, content] of tree.files) {
      const filePath = path.join(/*turbopackIgnore: true*/ tmp, relPath);
      if (!filePath.startsWith(tmp + path.sep)) {
        throw new RegistryError(`Unsafe plugin file path: ${relPath}`);
      }
      fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(filePath), {
        recursive: true,
      });
      fs.writeFileSync(/*turbopackIgnore: true*/ filePath, content, "utf8");
      count++;
    }
    if (fs.existsSync(/*turbopackIgnore: true*/ dest)) {
      fs.rmSync(/*turbopackIgnore: true*/ dest, { recursive: true, force: true });
    }
    fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(dest), { recursive: true });
    fs.renameSync(/*turbopackIgnore: true*/ tmp, dest);
    return count;
  } catch (err) {
    fs.rmSync(/*turbopackIgnore: true*/ tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Remove an installed plugin tree from disk. */
export function removePluginTree(
  marketplaceName: string,
  pluginName: string,
  options: WritePluginOptions = {}
): void {
  fs.rmSync(/*turbopackIgnore: true*/ pluginDir(marketplaceName, pluginName, options), {
    recursive: true,
    force: true,
  });
}
