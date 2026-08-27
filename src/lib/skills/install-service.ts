/**
 * Registry → store installation flow shared by the skills API routes.
 * Downloads from ClawHub / skills.sh / GitHub, derives a spec-valid
 * install name and handles collisions:
 *  - same registry item already installed → replace (update in place)
 *  - name owned by someone else → numeric suffix (-2, -3, …)
 */

import {
  parseSkillMd,
  setSkillMdName,
  slugifySkillName,
  type SkillFile,
  type SkillSource,
} from "./config";
import {
  downloadClawHubSkill,
  type ClawHubSearchResult,
} from "./registries/clawhub";
import { fetchSkillFromGithub, parseGithubRepoRef } from "./registries/github";
import { GuardedFetchOptions, RegistryError } from "./registries/http";
import {
  downloadSkillsShSkill,
  type SkillsShResult,
} from "./registries/skillssh";
import { getSkillByName, installSkill, type SkillRow, type StoreOptions } from "./store";

export type RegistryInstallResult =
  | { ok: true; row: SkillRow; replaced: boolean; via?: string }
  | { ok: false; error: string };

/** Derive the preferred install name from the downloaded SKILL.md. */
function deriveSkillName(files: SkillFile[], fallback: string): string | null {
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (skillMd) {
    const parsed = parseSkillMd(skillMd.content);
    if (!("error" in parsed) && parsed.frontmatter.name) {
      return parsed.frontmatter.name;
    }
  }
  return slugifySkillName(fallback);
}

/** Same registry item as an existing row? (replace → update in place) */
function isSameSource(existing: SkillRow, source: SkillSource): boolean {
  const prev = (existing.source ?? {}) as Record<string, unknown>;
  if (prev.kind !== source.kind) return false;
  if (source.kind === "clawhub") return prev.slug === source.slug;
  if (source.kind === "skillssh") return prev.id === source.id;
  if (source.kind === "github") {
    return (
      prev.owner === source.owner &&
      prev.repo === source.repo &&
      (prev.path ?? "") === (source.path ?? "")
    );
  }
  return false;
}

async function installWithCollision(
  files: SkillFile[],
  source: SkillSource,
  preferredName: string,
  version: string | undefined,
  options: StoreOptions
): Promise<RegistryInstallResult> {
  let candidate = preferredName;
  for (let attempt = 2; attempt <= 10; attempt++) {
    const existing = await getSkillByName(candidate, options);
    if (existing) {
      if (isSameSource(existing, source)) {
        const renamed = files.map((f) =>
          f.path === "SKILL.md" ? { ...f, content: setSkillMdName(f.content, candidate) } : f
        );
        const result = await installSkill(
          { name: candidate, files: renamed, source, version },
          options
        );
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, row: result.row, replaced: true };
      }
      candidate = `${preferredName}-${attempt}`.slice(0, 64).replace(/-+$/g, "");
      continue;
    }

    const renamed = files.map((f) =>
      f.path === "SKILL.md" ? { ...f, content: setSkillMdName(f.content, candidate) } : f
    );
    const result = await installSkill(
      { name: candidate, files: renamed, source, version },
      options
    );
    if (result.ok) return { ok: true, row: result.row, replaced: result.replaced };
    return { ok: false, error: result.error };
  }
  return { ok: false, error: "Too many name collisions; pick another skill." };
}

/* ── Per-registry installers ─────────────────────────────────────── */

export async function installFromClawHub(
  ref: string,
  options: StoreOptions & GuardedFetchOptions & { version?: string } = {}
): Promise<RegistryInstallResult> {
  let download;
  try {
    download = await downloadClawHubSkill(ref, options);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const slug = ref.startsWith("@") ? ref.split("/")[1] : ref;
  const name = deriveSkillName(download.files, slug);
  if (!name) return { ok: false, error: "Could not derive a valid skill name." };
  const source: SkillSource = { kind: "clawhub", slug: ref };
  const result = await installWithCollision(
    download.files,
    source,
    name,
    download.version,
    options
  );
  if (result.ok) return { ...result, via: download.via };
  return result;
}

export async function installFromSkillsSh(
  entry: Pick<SkillsShResult, "id" | "source" | "skillId">,
  options: StoreOptions & GuardedFetchOptions = {}
): Promise<RegistryInstallResult> {
  let download;
  try {
    download = await downloadSkillsShSkill(entry, options);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const name = deriveSkillName(download.files, entry.skillId);
  if (!name) return { ok: false, error: "Could not derive a valid skill name." };
  const source: SkillSource = {
    kind: "skillssh",
    id: entry.id,
    repo: entry.source,
    path: download.path,
  };
  return installWithCollision(download.files, source, name, undefined, options);
}

export async function installFromGithub(
  input: { repo: string; path?: string; ref?: string },
  options: StoreOptions & GuardedFetchOptions = {}
): Promise<RegistryInstallResult> {
  const repoRef = parseGithubRepoRef(input.repo);
  if (!repoRef) {
    return { ok: false, error: "Enter a GitHub repo as 'owner/repo' or a github.com URL." };
  }
  if (input.ref) repoRef.ref = input.ref;

  let files: SkillFile[];
  try {
    files = await fetchSkillFromGithub(repoRef, input.path ?? repoRef.subpath ?? "", options);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const fallback = input.path
    ? (input.path.split("/").pop() ?? repoRef.repo)
    : (repoRef.subpath?.split("/").pop() ?? repoRef.repo);
  const name = deriveSkillName(files, fallback);
  if (!name) return { ok: false, error: "Could not derive a valid skill name." };
  const source: SkillSource = {
    kind: "github",
    owner: repoRef.owner,
    repo: repoRef.repo,
    path: input.path ?? repoRef.subpath ?? "",
    ref: repoRef.ref ?? "HEAD",
  };
  return installWithCollision(files, source, name, undefined, options);
}

/** Re-export for route payload validation. */
export type { ClawHubSearchResult };
export { RegistryError };
