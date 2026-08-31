/**
 * Shared client-side types and helpers for the Skills page. The API
 * routes are the source of truth; these shapes mirror their JSON
 * payloads (see src/app/api/skills/*). Kept in one module so the
 * Manage and Marketplace views stay type-aligned without prop-drilling
 * server types through the component tree.
 */

export type SkillRow = {
  id: string;
  name: string;
  description: string;
  version: string | null;
  enabled: boolean;
  pluginId: string | null;
  source?: { kind?: string; [key: string]: unknown } | null;
};

export type ClawHubResult = {
  slug: string;
  displayName?: string;
  summary?: string;
  version?: string;
  ownerHandle?: string;
  downloads?: number;
  updatedAt?: number;
};

export type SkillsShResult = {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
};

export type GithubSkillEntry = { name: string; dirPath: string };

export type RegistryTab = "clawhub" | "skillssh" | "github";

/** A marketplace result normalized into one render shape per registry. */
export type MarketplaceItem = {
  /** Stable per-render key + install busy marker. */
  key: string;
  title: string;
  /** Author / repo line under the title (may be empty). */
  byline?: string;
  summary?: string;
  /** Download / install count, when the registry reports one. */
  installs?: number;
  /** Payload for POST /api/skills/install. */
  installPayload: Record<string, unknown>;
};

export type WizardFile = { path: string; content: string };

/** Human label for an installed skill's provenance. */
export function sourceLabel(skill: SkillRow): string {
  const src = skill.source ?? {};
  switch (src.kind) {
    case "clawhub":
      return `ClawHub · ${String(src.slug ?? "")}`;
    case "skillssh":
      return `skills.sh · ${String(src.id ?? "")}`;
    case "github":
      return `GitHub · ${String(src.owner ?? "")}/${String(src.repo ?? "")}`;
    case "plugin":
      return `Plugin · ${String(src.plugin ?? "")}`;
    case "builtin":
      return "Built-in";
    default:
      return "Local";
  }
}

/**
 * Match an installed row against a marketplace item's install payload.
 * Uses the same equality rules as the install service's collision
 * handling (slug / skills.sh id / GitHub owner+repo+path), falling back
 * to a name match so renamed installs still resolve.
 */
export function isInstalled(skill: SkillRow, item: MarketplaceItem): boolean {
  const src = skill.source ?? {};
  const payload = item.installPayload;

  if (payload.registry === "clawhub" && typeof payload.ref === "string") {
    if (src.kind !== "clawhub" || typeof src.slug !== "string") return false;
    return normalizeClawhubRef(src.slug) === normalizeClawhubRef(payload.ref);
  }

  if (payload.registry === "skillssh") {
    if (src.kind !== "skillssh") return false;
    // Installed rows store the full "{owner}/{repo}/{skillId}" path.
    const installedId = typeof src.id === "string" ? src.id : "";
    const expected =
      typeof payload.skillId === "string" && typeof payload.source === "string"
        ? `${payload.source}/${payload.skillId}`
        : null;
    if (installedId === String(payload.id)) return true;
    return expected !== null && installedId === expected;
  }

  if (
    payload.registry === "github" &&
    typeof payload.repo === "string"
  ) {
    if (src.kind !== "github") return false;
    const repo = payload.repo.replace(/\.git$/, "").replace(
      /^https?:\/\/github\.com\//,
      ""
    );
    const [owner, repoName, ...rest] = repo.split("/");
    if (src.owner !== owner || src.repo !== repoName) return false;
    const path = typeof payload.path === "string" ? payload.path : rest.join("/");
    return String(src.path ?? "") === path;
  }

  return false;
}

/** Canonicalize a ClawHub ref ("@owner/slug" and "slug" compare equal by slug). */
function normalizeClawhubRef(ref: string): string {
  const trimmed = ref.trim();
  return trimmed.startsWith("@") ? trimmed.split("/")[1] ?? trimmed : trimmed;
}

