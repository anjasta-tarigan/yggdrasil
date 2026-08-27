/**
 * Agent Skills (agentskills.io) spec types and validation.
 *
 * Pure module (no server-only imports) so it can be shared between the
 * server-side skill store, the API routes and the browser UI. A skill is
 * a folder containing a SKILL.md file with YAML frontmatter (name and
 * description required) plus optional bundled resource files.
 *
 * Spec reference: https://agentskills.io/specification
 */

import { parse as parseYaml } from "yaml";

/* ── Limits ──────────────────────────────────────────────────────── */

export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;
/** Max bundled files per skill (SKILL.md included). */
export const MAX_SKILL_FILES = 100;
/** Max size of a single skill file (2 MB). */
export const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
/** Max combined size of all files in a skill (20 MB). */
export const MAX_SKILL_TOTAL_BYTES = 20 * 1024 * 1024;
/** Max SKILL.md body served to the model via use_skill (512 KB). */
export const MAX_SKILL_BODY_BYTES = 512 * 1024;
/** Max file content returned by read_skill_file (200 KB, ClawHub parity). */
export const MAX_SKILL_FILE_PREVIEW_BYTES = 200 * 1024;
/** Max path length for a bundled file. */
export const MAX_SKILL_PATH_LENGTH = 512;
/**
 * Per-skill listing cap for the description shown in the prompt catalog
 * (Claude Code truncates description + when_to_use at 1,536 chars).
 */
export const SKILL_LISTING_DESCRIPTION_CAP = 1536;

/* ── Types ───────────────────────────────────────────────────────── */

export type SkillSourceKind =
  | "clawhub"
  | "skillssh"
  | "github"
  | "local"
  | "plugin"
  | "builtin";

/**
 * Provenance recorded when a skill is installed. `kind` is required;
 * the remaining fields are free-form strings describing the source
 * (registry slug, GitHub owner/repo/path, plugin name, …).
 */
export type SkillSource = {
  kind: SkillSourceKind;
  [key: string]: string | undefined;
};

/** Parsed + validated SKILL.md frontmatter (agentskills.io fields). */
export type SkillFrontmatter = {
  name?: string;
  description: string;
  license?: string;
  compatibility?: string;
  /** Arbitrary string→string metadata map. */
  metadata?: Record<string, string>;
  /** Experimental allowed-tools declaration (stored, not enforced). */
  allowedTools?: string;
};

export type ParsedSkillMd = {
  frontmatter: SkillFrontmatter;
  /** Markdown body after the frontmatter block. */
  body: string;
  /** Raw frontmatter keys that are not part of the open spec. */
  unknownFields: string[];
};

/** One file of a skill bundle (relative POSIX path + text content). */
export type SkillFile = {
  path: string;
  content: string;
};

/* ── Name / description validation ───────────────────────────────── */

/**
 * Spec name rule: lowercase letters, digits and hyphens; must not start
 * or end with a hyphen; no consecutive hyphens; at most 64 chars.
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= MAX_SKILL_NAME_LENGTH &&
    SKILL_NAME_RE.test(name)
  );
}

/**
 * Slugify an arbitrary label into a spec-valid skill name (used when
 * namespacing plugin skills). Returns null when nothing usable remains.
 */
export function slugifySkillName(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_SKILL_NAME_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/* ── File path sanitization ──────────────────────────────────────── */

/**
 * Validate a bundled-file path. Only relative POSIX paths are accepted:
 * no absolute paths, no `..` segments, no backslashes or NUL bytes,
 * bounded length. Returns the normalized path or null when invalid.
 */
export function sanitizeSkillFilePath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_SKILL_PATH_LENGTH ||
    trimmed.includes("\0") ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return null;

  const segments = trimmed.split("/");
  const clean: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    clean.push(segment);
  }
  if (clean.length === 0) return null;
  return clean.join("/");
}

/**
 * Validate a whole file list: paths sanitized, SKILL.md present (either
 * at the root or as the single root-level SKILL.md of a skill folder),
 * file count and per-file/total byte caps enforced. Returns the
 * sanitized files (paths normalized, SKILL.md first) or an error.
 */
export function sanitizeSkillFiles(
  files: SkillFile[]
): { ok: true; files: SkillFile[] } | { ok: false; error: string } {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "A skill needs at least a SKILL.md file." };
  }
  if (files.length > MAX_SKILL_FILES) {
    return {
      ok: false,
      error: `Too many files (max ${MAX_SKILL_FILES}).`,
    };
  }

  const seen = new Set<string>();
  const clean: SkillFile[] = [];
  let totalBytes = 0;
  let hasSkillMd = false;

  for (const file of files) {
    if (typeof file?.content !== "string") {
      return { ok: false, error: "Every skill file needs string content." };
    }
    const path = sanitizeSkillFilePath(file.path);
    if (!path) {
      return {
        ok: false,
        error: `Invalid file path: ${String(file.path).slice(0, 120)}`,
      };
    }
    if (seen.has(path)) {
      return { ok: false, error: `Duplicate file path: ${path}` };
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_SKILL_FILE_BYTES) {
      return {
        ok: false,
        error: `File too large (max 2 MB each): ${path}`,
      };
    }
    totalBytes += bytes;
    if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
      return { ok: false, error: "Skill exceeds the 20 MB total size cap." };
    }
    seen.add(path);
    if (path === "SKILL.md") hasSkillMd = true;
    clean.push({ path, content: file.content });
  }

  if (!hasSkillMd) {
    return { ok: false, error: "Missing SKILL.md at the skill root." };
  }

  // SKILL.md first so installers can parse metadata before writing extras.
  clean.sort((a, b) =>
    a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : 0
  );
  return { ok: true, files: clean };
}

/* ── SKILL.md parsing ────────────────────────────────────────────── */

const SPEC_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

/**
 * Split a SKILL.md document into YAML frontmatter and markdown body.
 * Accepts documents without frontmatter too (body only). Returns null
 * when the frontmatter block is present but not a YAML mapping.
 */
export function splitFrontmatter(text: string): {
  yamlBlock: string | null;
  body: string;
} {
  // Tolerate a leading BOM/whitespace before the opening marker.
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(
    text
  );
  if (!match) return { yamlBlock: null, body: text };
  return { yamlBlock: match[1], body: text.slice(match[0].length) };
}

/**
 * Parse and validate a SKILL.md document against the agentskills.io
 * spec. Claude Code extension fields (context, hooks, model, …) are
 * tolerated: reported in `unknownFields` but never rejected, since
 * registry skills routinely ship with them.
 */
export function parseSkillMd(text: string): ParsedSkillMd | { error: string } {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { error: "SKILL.md is empty." };
  }

  const { yamlBlock, body } = splitFrontmatter(text);
  let raw: unknown = null;
  if (yamlBlock !== null) {
    try {
      raw = parseYaml(yamlBlock);
    } catch (err) {
      return {
        error: `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
      return { error: "SKILL.md frontmatter must be a YAML mapping." };
    }
  }

  const record = (raw ?? {}) as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (key) => !SPEC_FIELDS.has(key)
  );

  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  if (!description) {
    return {
      error:
        "SKILL.md frontmatter needs a non-empty 'description' (the model uses it to decide when to apply the skill).",
    };
  }
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return {
      error: `description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`,
    };
  }

  const frontmatter: SkillFrontmatter = { description };

  if (record.name !== undefined) {
    if (!isValidSkillName(record.name)) {
      return {
        error: `name '${String(record.name).slice(0, 80)}' violates the spec (lowercase letters, digits, hyphens; max ${MAX_SKILL_NAME_LENGTH} chars; no leading/trailing/consecutive hyphens).`,
      };
    }
    frontmatter.name = record.name;
  }

  if (record.license !== undefined) {
    if (typeof record.license !== "string") {
      return { error: "license must be a string." };
    }
    frontmatter.license = record.license;
  }

  if (record.compatibility !== undefined) {
    if (
      typeof record.compatibility !== "string" ||
      record.compatibility.length > MAX_SKILL_COMPATIBILITY_LENGTH
    ) {
      return {
        error: `compatibility must be a string of at most ${MAX_SKILL_COMPATIBILITY_LENGTH} characters.`,
      };
    }
    frontmatter.compatibility = record.compatibility;
  }

  if (record.metadata !== undefined) {
    if (typeof record.metadata !== "object" || Array.isArray(record.metadata) || record.metadata === null) {
      return { error: "metadata must be a key-value mapping." };
    }
    const metadata: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      record.metadata as Record<string, unknown>
    )) {
      metadata[key] = typeof value === "string" ? value : JSON.stringify(value);
    }
    frontmatter.metadata = metadata;
  }

  if (record["allowed-tools"] !== undefined) {
    if (typeof record["allowed-tools"] !== "string") {
      return { error: "allowed-tools must be a string." };
    }
    frontmatter.allowedTools = record["allowed-tools"];
  }

  return { frontmatter, body, unknownFields };
}

/**
 * Rewrite (or insert) the frontmatter `name` field of a SKILL.md
 * document. Used when a skill is installed under a namespaced or
 * collision-renamed name that differs from its upstream name.
 */
export function setSkillMdName(content: string, name: string): string {
  const { yamlBlock, body } = splitFrontmatter(content);
  if (yamlBlock === null) {
    return `---\nname: ${name}\n---\n${body}`;
  }
  let replaced = false;
  const lines = yamlBlock.split("\n").map((line) => {
    if (/^name\s*:/.test(line)) {
      replaced = true;
      return `name: ${name}`;
    }
    return line;
  });
  if (!replaced) lines.unshift(`name: ${name}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * Sanitize a SkillSource payload coming from an API request or another
 * module. Only a known kind plus bounded string fields survive.
 */
export function sanitizeSkillSource(value: unknown): SkillSource | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (
    kind !== "clawhub" &&
    kind !== "skillssh" &&
    kind !== "github" &&
    kind !== "local" &&
    kind !== "plugin" &&
    kind !== "builtin"
  ) {
    return null;
  }
  const source: SkillSource = { kind };
  for (const [key, fieldValue] of Object.entries(v)) {
    if (key === "kind") continue;
    if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) && typeof fieldValue === "string" && fieldValue.length <= 2048) {
      source[key] = fieldValue;
    }
  }
  return source;
}
