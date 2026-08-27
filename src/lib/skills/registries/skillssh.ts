/**
 * skills.sh registry client (Vercel Labs' agent-skill directory).
 *
 * The official /api/v1 API requires Vercel OIDC auth, which a
 * self-hosted app cannot provide. The website's public search endpoint
 * is used instead, and installs resolve through GitHub — exactly what
 * the `npx skills` CLI does (every catalog entry is a GitHub repo).
 */

import type { SkillFile } from "../config";
import { fetchJson, GuardedFetchOptions, RegistryError } from "./http";
import {
  fetchSkillFromGithub,
  listRepoSkillDirs,
  parseGithubRepoRef,
} from "./github";

const BASE = "https://www.skills.sh";

export interface SkillsShResult {
  /** "{owner}/{repo}/{skillId}" */
  id: string;
  skillId: string;
  name: string;
  installs: number;
  /** GitHub "owner/repo" hosting the skill. */
  source: string;
  url?: string;
}

interface RawSkillsShResponse {
  query?: string;
  searchType?: string;
  skills?: Array<{
    id?: string;
    skillId?: string;
    name?: string;
    installs?: number;
    source?: string;
    url?: string;
  }>;
  error?: string;
  message?: string;
}

/** Search the skills.sh catalog (public web endpoint, no auth). */
export async function searchSkillsSh(
  query: string,
  options: GuardedFetchOptions = {}
): Promise<SkillsShResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const data = await fetchJson<RawSkillsShResponse>(
    `${BASE}/api/search?q=${encodeURIComponent(q)}`,
    options
  );
  if (data.error) {
    throw new RegistryError(`skills.sh search failed: ${data.error}`);
  }
  return (data.skills ?? [])
    .filter((s) => s.id && s.source && s.skillId)
    .map((s) => ({
      id: s.id as string,
      skillId: s.skillId as string,
      name: s.name ?? s.skillId ?? s.id ?? "",
      installs: s.installs ?? 0,
      source: s.source as string,
      url: s.url,
    }));
}

/**
 * Download one skill listed on skills.sh. The catalog entry's `source`
 * is a GitHub "owner/repo"; the skill folder is located by matching the
 * `skillId` against the repo's SKILL.md directories.
 */
export async function downloadSkillsShSkill(
  result: Pick<SkillsShResult, "source" | "skillId">,
  options: GuardedFetchOptions = {}
): Promise<{ files: SkillFile[]; path: string }> {
  const repoRef = parseGithubRepoRef(result.source);
  if (!repoRef) {
    throw new RegistryError(`Unrecognized skills.sh source: ${result.source}`);
  }

  const entries = await listRepoSkillDirs(repoRef, options);
  const match = entries.find((e) => e.name === result.skillId);
  if (!match) {
    // Fall back to a subpath-style lookup ("owner/repo/sub/dir" entries).
    const asPath = parseGithubRepoRef(`${result.source}/${result.skillId}`);
    if (asPath) {
      try {
        const files = await fetchSkillFromGithub(
          { owner: asPath.owner, repo: asPath.repo, ref: asPath.ref },
          asPath.subpath ?? "",
          options
        );
        return { files, path: asPath.subpath ?? "" };
      } catch {
        // fall through to the listing error below
      }
    }
    throw new RegistryError(
      `Skill '${result.skillId}' was not found in ${result.source}. Available: ${entries
        .slice(0, 10)
        .map((e) => e.name)
        .join(", ") || "none"}`
    );
  }

  const files = await fetchSkillFromGithub(repoRef, match.dirPath, options);
  return { files, path: match.dirPath };
}
