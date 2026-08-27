/**
 * ClawHub registry client (clawhub.ai — OpenClaw's public skill
 * registry). All endpoints used here are public (no auth):
 *   GET /api/v1/search, /api/v1/skills, /api/v1/skills/{slug},
 *   GET /api/v1/download?slug=&tag=|version=
 *
 * Downloads return a ZIP for registry-hosted skills, or a JSON
 * "GitHub handoff" for GitHub-backed skills, which is resolved through
 * the GitHub client.
 */

import type { SkillFile } from "../config";
import {
  extractZipToSkillFiles,
  fetchJson,
  guardedFetch,
  GuardedFetchOptions,
  RegistryError,
} from "./http";
import { fetchSkillFromGithub } from "./github";

const BASE = "https://clawhub.ai";

/**
 * Split a ClawHub skill reference into slug + optional owner handle.
 * Accepts "@owner/slug" (canonical ref) and bare "slug".
 */
export function parseClawHubRef(input: string): {
  slug: string;
  ownerHandle?: string;
} | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) {
    const match = /^@([a-z0-9_-]+)\/([a-z0-9_-]+)$/i.exec(trimmed);
    if (!match) return null;
    return { ownerHandle: match[1], slug: match[2] };
  }
  if (!/^[a-z0-9_-]+$/i.test(trimmed)) return null;
  return { slug: trimmed };
}

export interface ClawHubSearchResult {
  slug: string;
  displayName?: string;
  summary?: string;
  version?: string;
  ownerHandle?: string;
  downloads?: number;
  updatedAt?: number;
  suspicious?: boolean;
}

export interface ClawHubSkillDetail {
  slug: string;
  displayName?: string;
  summary?: string;
  /** Full SKILL.md text (ClawHub stores it in the description field). */
  skillMd?: string;
  latestVersion?: string;
  ownerHandle?: string;
  moderation?: {
    verdict?: string;
    isSuspicious?: boolean;
    summary?: string;
  };
}

interface RawSearchResult {
  slug?: string;
  displayName?: string;
  summary?: string;
  version?: string;
  ownerHandle?: string;
  downloads?: number;
  updatedAt?: number;
  flagged?: { suspicious?: boolean };
  native?: {
    owner?: { handle?: string };
    skill?: { slug?: string; displayName?: string; summary?: string };
  };
  install?: { reference?: string };
}

/** Search ClawHub skills (suspicious-flagged skills hidden). */
export async function searchClawHub(
  query: string,
  options: GuardedFetchOptions & { limit?: number } = {}
): Promise<ClawHubSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  const data = await fetchJson<{ results?: RawSearchResult[] }>(
    `${BASE}/api/v1/search?q=${encodeURIComponent(q)}&limit=${limit}&nonSuspiciousOnly=true`,
    options
  );
  return (data.results ?? []).map(normalizeSearchResult);
}

function normalizeSearchResult(raw: RawSearchResult): ClawHubSearchResult {
  const slug = raw.slug ?? raw.native?.skill?.slug ?? raw.install?.reference ?? "";
  return {
    slug,
    displayName: raw.displayName ?? raw.native?.skill?.displayName,
    summary: raw.summary ?? raw.native?.skill?.summary,
    version: raw.version,
    ownerHandle: raw.ownerHandle ?? raw.native?.owner?.handle,
    downloads: raw.downloads,
    updatedAt: raw.updatedAt,
    suspicious: raw.flagged?.suspicious === true,
  };
}

/** Browse the ClawHub catalog (default sort: recommended). */
export async function listClawHubSkills(
  options: GuardedFetchOptions & {
    sort?: "updated" | "recommended" | "createdAt" | "downloads" | "stars" | "name" | "trending";
    limit?: number;
    cursor?: string;
  } = {}
): Promise<{ items: ClawHubSearchResult[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  params.set("sort", options.sort ?? "recommended");
  params.set("limit", String(Math.min(Math.max(options.limit ?? 20, 1), 100)));
  params.set("nonSuspiciousOnly", "true");
  if (options.cursor) params.set("cursor", options.cursor);
  const data = await fetchJson<{
    items?: Array<RawSearchResult & { stats?: Record<string, number>; tags?: Record<string, string> }>;
    nextCursor?: string | null;
  }>(`${BASE}/api/v1/skills?${params.toString()}`, options);

  const items = (data.items ?? []).map((raw) => {
    const result = normalizeSearchResult(raw);
    if (!result.version && raw.tags?.latest) result.version = raw.tags.latest;
    if (result.downloads === undefined && raw.stats?.downloads !== undefined) {
      result.downloads = raw.stats.downloads;
    }
    return result;
  });
  return { items, nextCursor: data.nextCursor ?? null };
}

/** Fetch one skill's detail page data (includes the full SKILL.md). */
export async function getClawHubSkill(
  ref: string,
  options: GuardedFetchOptions = {}
): Promise<ClawHubSkillDetail> {
  const parsed = parseClawHubRef(ref);
  if (!parsed) throw new RegistryError(`Invalid ClawHub skill reference: ${ref}`);
  const params = new URLSearchParams();
  if (parsed.ownerHandle) params.set("ownerHandle", parsed.ownerHandle);
  const query = params.toString() ? `?${params.toString()}` : "";
  const data = await fetchJson<{
    skill?: {
      slug?: string;
      displayName?: string;
      summary?: string;
      description?: string;
    };
    latestVersion?: { version?: string };
    owner?: { handle?: string };
    moderation?: { verdict?: string; isSuspicious?: boolean; summary?: string };
  }>(`${BASE}/api/v1/skills/${encodeURIComponent(parsed.slug)}${query}`, options);

  if (!data.skill?.slug) {
    throw new RegistryError(`ClawHub skill not found: ${ref}`, 404);
  }
  return {
    slug: data.skill.slug,
    displayName: data.skill.displayName,
    summary: data.skill.summary,
    skillMd: data.skill.description,
    latestVersion: data.latestVersion?.version,
    ownerHandle: data.owner?.handle,
    moderation: data.moderation,
  };
}

interface GithubHandoff {
  sourceRef?: string;
  repo?: string;
  commit?: string;
  path?: string;
  archiveUrl?: string;
}

/**
 * Download a skill's files from ClawHub. Hosted versions stream a ZIP;
 * GitHub-backed skills answer with a JSON handoff that names the repo,
 * commit and path to fetch instead. Accepts "@owner/slug" refs to
 * disambiguate slugs used by multiple publishers.
 */
export async function downloadClawHubSkill(
  ref: string,
  options: GuardedFetchOptions & { version?: string; tag?: string } = {}
): Promise<{ files: SkillFile[]; version?: string; via: "clawhub-zip" | "github-handoff" }> {
  const parsed = parseClawHubRef(ref);
  if (!parsed) throw new RegistryError(`Invalid ClawHub skill reference: ${ref}`);

  const params = new URLSearchParams({ slug: parsed.slug });
  if (parsed.ownerHandle) params.set("ownerHandle", parsed.ownerHandle);
  if (options.version) params.set("version", options.version);
  else params.set("tag", options.tag ?? "latest");

  const url = `${BASE}/api/v1/download?${params.toString()}`;
  // Hosted downloads arrive as a ZIP; GitHub-backed skills answer with
  // a JSON handoff document.
  const response = await guardedFetch(url, options);

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/zip")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    const extracted = extractZipToSkillFiles(bytes);
    if (!extracted.ok) throw new RegistryError(extracted.error);
    return { files: extracted.files, version: options.version, via: "clawhub-zip" };
  }

  // JSON handoff (or an error object).
  const text = await response.text();
  let handoff: GithubHandoff & { error?: string; message?: string };
  try {
    handoff = JSON.parse(text);
  } catch {
    throw new RegistryError(`Unexpected ClawHub download response (${contentType}).`);
  }
  if (handoff.error || handoff.message) {
    throw new RegistryError(`ClawHub download failed: ${handoff.error ?? handoff.message}`);
  }
  if (handoff.sourceRef !== "public-github" || !handoff.repo) {
    throw new RegistryError("ClawHub returned an unrecognized download handoff.");
  }

  const [owner, repo] = handoff.repo.split("/");
  if (!owner || !repo) {
    throw new RegistryError(`Bad GitHub handoff repo: ${handoff.repo}`);
  }
  const files = await fetchSkillFromGithub(
    { owner, repo, ref: handoff.commit },
    handoff.path ?? "",
    options
  );
  return { files, version: options.version ?? handoff.commit, via: "github-handoff" };
}
