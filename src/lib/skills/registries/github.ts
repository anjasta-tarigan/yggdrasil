/**
 * GitHub skill resolution — shared by the skills.sh installer, the
 * direct "install from GitHub" flow and the plugin installer.
 *
 * Listing uses the git trees API (one API call); file content comes
 * from raw.githubusercontent.com, which is not API-rate-limited.
 */

import {
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  type SkillFile,
} from "../config";
import { fetchBuffer, fetchJson, GuardedFetchOptions, RegistryError } from "./http";

export interface GithubRepoRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit. Defaults to the default branch ("HEAD"). */
  ref?: string;
  /** Optional subpath inside the repo. */
  subpath?: string;
}

export interface RepoSkillEntry {
  /** Skill directory name (the spec name). */
  name: string;
  /** Repo-relative skill directory path ("" for a root SKILL.md). */
  dirPath: string;
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Parse user input into a GitHub repo reference. Accepts:
 *  - "owner/repo"
 *  - "owner/repo/sub/path"
 *  - "https://github.com/owner/repo[.git][/tree/<ref>[/path]]"
 */
export function parseGithubRepoRef(input: string): GithubRepoRef | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  if (!trimmed) return null;

  if (/^https?:\/\//.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const [owner, repo, ...rest] = parts;
    const ref: GithubRepoRef = { owner, repo };
    if (rest[0] === "tree" && rest.length >= 2) {
      ref.ref = rest[1];
      if (rest.length > 2) ref.subpath = rest.slice(2).join("/");
    } else if (rest.length > 0 && rest[0] !== "blob") {
      ref.subpath = rest.join("/");
    }
    return isValidOwnerRepo(ref) ? ref : null;
  }

  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, ...rest] = parts;
  const ref: GithubRepoRef = { owner, repo };
  if (rest.length > 0) ref.subpath = rest.join("/");
  return isValidOwnerRepo(ref) ? ref : null;
}

function isValidOwnerRepo(ref: GithubRepoRef): boolean {
  return (
    SEGMENT_RE.test(ref.owner) &&
    SEGMENT_RE.test(ref.repo) &&
    ref.owner.length <= 100 &&
    ref.repo.length <= 100 &&
    (ref.subpath === undefined || ref.subpath.length <= 512)
  );
}

interface GitTreeResponse {
  tree?: Array<{ path: string; type: string }>;
  truncated?: boolean;
}

/**
 * List every skill in a repo — any directory containing a SKILL.md,
 * plus a root SKILL.md when present. Names come from the directory
 * basename; when two skills share a basename the shallowest wins.
 */
export async function listRepoSkillDirs(
  ref: GithubRepoRef,
  options: GuardedFetchOptions = {}
): Promise<RepoSkillEntry[]> {
  const gitRef = ref.ref ?? "HEAD";
  const data = await fetchJson<GitTreeResponse>(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(gitRef)}?recursive=1`,
    options
  );
  if (!Array.isArray(data.tree)) {
    throw new RegistryError("GitHub trees API returned an unexpected payload.");
  }
  if (data.truncated) {
    throw new RegistryError(
      "Repository tree is too large to enumerate; point at a narrower path."
    );
  }

  const prefix = ref.subpath ? ref.subpath.replace(/\/+$/, "") + "/" : "";
  const candidates: RepoSkillEntry[] = [];
  for (const node of data.tree) {
    if (
      node.type !== "blob" ||
      (node.path !== "SKILL.md" && !node.path.endsWith("/SKILL.md"))
    )
      continue;
    if (prefix && !node.path.startsWith(prefix)) continue;
    const relative = prefix ? node.path.slice(prefix.length) : node.path;
    const dir =
      relative === "SKILL.md" ? "" : relative.slice(0, -"/SKILL.md".length);
    const name = dir ? (dir.split("/").pop() as string) : ref.repo;
    candidates.push({ name, dirPath: (prefix + dir).replace(/\/+$/, "") });
  }

  // Shallowest directory wins on basename collisions.
  candidates.sort(
    (a, b) =>
      a.dirPath.split("/").length - b.dirPath.split("/").length ||
      a.name.localeCompare(b.name)
  );
  const entries: RepoSkillEntry[] = [];
  for (const candidate of candidates) {
    if (!entries.some((e) => e.name === candidate.name)) entries.push(candidate);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetch one file from raw.githubusercontent.com. */
export async function fetchGithubRawFile(
  ref: GithubRepoRef,
  filePath: string,
  options: GuardedFetchOptions = {}
): Promise<string> {
  const gitRef = ref.ref ?? "HEAD";
  const buffer = await fetchBuffer(
    `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(gitRef)}/${filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    { ...options, maxBytes: MAX_SKILL_FILE_BYTES }
  );
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * Download a whole skill folder from GitHub. The tree is listed once;
 * every blob under the skill directory is fetched from the raw host
 * with per-file and total byte caps.
 */
export async function fetchSkillFromGithub(
  ref: GithubRepoRef,
  skillDirPath: string,
  options: GuardedFetchOptions = {}
): Promise<SkillFile[]> {
  const gitRef = ref.ref ?? "HEAD";
  const data = await fetchJson<GitTreeResponse>(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(gitRef)}?recursive=1`,
    options
  );
  if (!Array.isArray(data.tree)) {
    throw new RegistryError("GitHub trees API returned an unexpected payload.");
  }

  const prefix = skillDirPath ? skillDirPath.replace(/\/+$/, "") + "/" : "";
  const wanted = data.tree.filter((node) => {
    if (node.type !== "blob") return false;
    if (prefix) return node.path.startsWith(prefix);
    // For root-level skill, don't include files from nested skills if any
    return true;
  });
  if (wanted.length === 0) {
    throw new RegistryError(
      `No files found under '${skillDirPath || "/"}' in ${ref.owner}/${ref.repo}.`
    );
  }
  if (wanted.length > MAX_SKILL_FILES) {
    throw new RegistryError(`Skill folder has too many files (max ${MAX_SKILL_FILES}).`);
  }

  let totalBytes = 0;
  const files: SkillFile[] = [];
  for (const node of wanted) {
    const content = await fetchGithubRawFile(ref, node.path, options);
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      throw new RegistryError("Skill folder exceeds the total size cap.");
    }
    files.push({
      path: prefix ? node.path.slice(prefix.length) : node.path,
      content,
    });
  }

  if (!files.some((f) => f.path === "SKILL.md")) {
    throw new RegistryError("Skill folder is missing SKILL.md.");
  }
  return files;
}
