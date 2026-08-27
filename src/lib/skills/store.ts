/**
 * Skill store — disk content + SQLite registry metadata.
 *
 * Skill file bundles live under data/skills/<name>/ (SKILL.md plus
 * optional resources); the `skills` table tracks metadata, provenance
 * and enablement. Writes are atomic: files go to a temp directory that
 * is renamed into place after the old copy is removed.
 */

import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { skills } from "@/db/schema";
import {
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_FILE_PREVIEW_BYTES,
  parseSkillMd,
  sanitizeSkillFiles,
  sanitizeSkillSource,
  type SkillFile,
  type SkillSource,
} from "./config";

export type SkillRow = typeof skills.$inferSelect;

export interface StoreOptions {
  db?: AppDatabase;
  /** Override the skills root (tests). */
  root?: string;
}

/**
 * Root directory holding one folder per installed skill.
 *
 * The root is intentionally configurable (test injection + SKILLS_DIR
 * env override for deployments), so Turbopack cannot statically scope
 * the fs calls below. They carry turbopackIgnore markers; this app is
 * self-hosted, so whole-project tracing is a non-issue, but the
 * markers keep the build warning-free.
 */
export function skillsRoot(options: StoreOptions = {}): string {
  return (
    options.root ??
    process.env.SKILLS_DIR ??
    path.resolve(process.cwd(), "data", "skills")
  );
}

/** Absolute folder of one skill (no existence check). */
export function skillDir(name: string, options: StoreOptions = {}): string {
  return path.join(/*turbopackIgnore: true*/ skillsRoot(options), name);
}

function createSkillId(): string {
  return `skill-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export interface InstallSkillInput {
  /** Spec-valid skill name (lowercase alphanumerics + hyphens). */
  name: string;
  /** SKILL.md plus bundled resources (paths relative to the skill root). */
  files: SkillFile[];
  source: SkillSource;
  version?: string;
  pluginId?: string;
  /** Defaults to true. */
  enabled?: boolean;
}

export type InstallSkillResult =
  | { ok: true; row: SkillRow; replaced: boolean }
  | { ok: false; error: string };

/**
 * Install (or replace) a skill on disk and in the registry. The SKILL.md
 * frontmatter is parsed to record the description; a frontmatter `name`
 * that disagrees with the install name is rejected to keep folder, row
 * and spec alignment.
 */
export async function installSkill(
  input: InstallSkillInput,
  options: StoreOptions = {}
): Promise<InstallSkillResult> {
  const db = options.db ?? defaultDb;
  const name = input.name;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    return { ok: false, error: `Invalid skill name: ${name}` };
  }

  const sanitized = sanitizeSkillFiles(input.files);
  if (!sanitized.ok) return { ok: false, error: sanitized.error };

  const skillMd = sanitized.files.find((f) => f.path === "SKILL.md");
  if (!skillMd) {
    return { ok: false, error: "Missing SKILL.md at the skill root." };
  }

  const parsed = parseSkillMd(skillMd.content);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  if (parsed.frontmatter.name && parsed.frontmatter.name !== name) {
    return {
      ok: false,
      error: `SKILL.md frontmatter name '${parsed.frontmatter.name}' does not match install name '${name}'.`,
    };
  }

  const source = sanitizeSkillSource(input.source);
  if (!source) return { ok: false, error: "Invalid skill source payload." };

  const root = skillsRoot(options);
  const dest = path.join(/*turbopackIgnore: true*/ root, name);
  const tmp = path.join(
    /*turbopackIgnore: true*/ root,
    `.tmp-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  );

  fs.mkdirSync(/*turbopackIgnore: true*/ tmp, { recursive: true });
  try {
    for (const file of sanitized.files) {
      const filePath = path.join(/*turbopackIgnore: true*/ tmp, file.path);
      // Belt and braces: the sanitized path is relative and `..`-free.
      if (!filePath.startsWith(tmp + path.sep)) {
        throw new Error(`Unsafe skill file path: ${file.path}`);
      }
      fs.mkdirSync(/*turbopackIgnore: true*/ path.dirname(filePath), {
        recursive: true,
      });
      fs.writeFileSync(/*turbopackIgnore: true*/ filePath, file.content, "utf8");
    }

    const existing = await db.query.skills.findFirst({
      where: eq(skills.name, name),
    });

    if (fs.existsSync(/*turbopackIgnore: true*/ dest)) {
      fs.rmSync(/*turbopackIgnore: true*/ dest, { recursive: true, force: true });
    }
    fs.mkdirSync(/*turbopackIgnore: true*/ root, { recursive: true });
    fs.renameSync(/*turbopackIgnore: true*/ tmp, dest);

    if (existing) {
      const [row] = await db
        .update(skills)
        .set({
          description: parsed.frontmatter.description,
          version: input.version ?? existing.version,
          source,
          pluginId: input.pluginId !== undefined ? input.pluginId : existing.pluginId,
          enabled: input.enabled ?? existing.enabled,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, existing.id))
        .returning();
      return { ok: true, row, replaced: true };
    }

    const [row] = await db
      .insert(skills)
      .values({
        id: createSkillId(),
        name,
        description: parsed.frontmatter.description,
        version: input.version,
        enabled: input.enabled ?? true,
        source,
        pluginId: input.pluginId,
      })
      .returning();
    return { ok: true, row, replaced: false };
  } catch (err) {
    fs.rmSync(/*turbopackIgnore: true*/ tmp, { recursive: true, force: true });
    throw err;
  }
}

/** List registry rows (optionally only enabled skills). */
export async function listSkills(
  options: StoreOptions & { enabledOnly?: boolean } = {}
): Promise<SkillRow[]> {
  const db = options.db ?? defaultDb;
  if (options.enabledOnly) {
    return db.query.skills.findMany({
      where: and(eq(skills.enabled, true)),
    });
  }
  return db.query.skills.findMany();
}

export async function getSkillById(
  id: string,
  options: StoreOptions = {}
): Promise<SkillRow | undefined> {
  const db = options.db ?? defaultDb;
  return db.query.skills.findFirst({ where: eq(skills.id, id) });
}

export async function getSkillByName(
  name: string,
  options: StoreOptions = {}
): Promise<SkillRow | undefined> {
  const db = options.db ?? defaultDb;
  return db.query.skills.findFirst({ where: eq(skills.name, name) });
}

export async function setSkillEnabled(
  id: string,
  enabled: boolean,
  options: StoreOptions = {}
): Promise<SkillRow | undefined> {
  const db = options.db ?? defaultDb;
  const [row] = await db
    .update(skills)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(skills.id, id))
    .returning();
  return row;
}

/**
 * Remove a skill's folder and registry row. Plugin-owned skills should
 * be removed through the plugin uninstall cascade; the store itself
 * allows forced removal (used by that cascade).
 */
export async function uninstallSkill(
  id: string,
  options: StoreOptions = {}
): Promise<boolean> {
  const db = options.db ?? defaultDb;
  const row = await getSkillById(id, options);
  if (!row) return false;
  fs.rmSync(/*turbopackIgnore: true*/ skillDir(row.name, options), {
    recursive: true,
    force: true,
  });
  await db.delete(skills).where(eq(skills.id, id));
  return true;
}

/** Read the SKILL.md body (progressive disclosure step 2). */
export function getSkillBody(
  name: string,
  options: StoreOptions = {}
): { body: string; truncated: boolean } | null {
  const file = path.join(/*turbopackIgnore: true*/ skillDir(name, options), "SKILL.md");
  if (!fs.existsSync(/*turbopackIgnore: true*/ file)) return null;
  const raw = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  const parsed = parseSkillMd(raw);
  const body = "error" in parsed ? raw : parsed.body;
  if (Buffer.byteLength(body, "utf8") <= MAX_SKILL_BODY_BYTES) {
    return { body, truncated: false };
  }
  return {
    body: body.slice(0, MAX_SKILL_BODY_BYTES) + "\n\n[truncated]",
    truncated: true,
  };
}

/** List bundled file paths (relative POSIX), SKILL.md included. */
export function listSkillFiles(
  name: string,
  options: StoreOptions = {}
): string[] {
  const dir = skillDir(name, options);
  if (!fs.existsSync(/*turbopackIgnore: true*/ dir)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(/*turbopackIgnore: true*/ current, {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith(".tmp-")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * Read one bundled file (progressive disclosure step 3). Text files up
 * to the preview cap; binary or oversized files return a marker instead
 * of raw bytes.
 */
export function readSkillFile(
  name: string,
  filePath: string,
  options: StoreOptions = {}
):
  | { content: string; truncated: boolean }
  | { error: string } {
  const dir = skillDir(name, options);
  const resolved = path.resolve(/*turbopackIgnore: true*/ dir, filePath);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    return { error: "Path escapes the skill directory." };
  }
  if (
    !fs.existsSync(/*turbopackIgnore: true*/ resolved) ||
    !fs.statSync(/*turbopackIgnore: true*/ resolved).isFile()
  ) {
    return { error: `File not found: ${filePath}` };
  }
  const stat = fs.statSync(/*turbopackIgnore: true*/ resolved);
  if (stat.size > MAX_SKILL_FILE_PREVIEW_BYTES) {
    return {
      error: `File exceeds the ${MAX_SKILL_FILE_PREVIEW_BYTES / 1024} KB read cap (${Math.round(stat.size / 1024)} KB).`,
    };
  }
  const buffer = fs.readFileSync(/*turbopackIgnore: true*/ resolved);
  // Reject NUL bytes as a cheap binary-file heuristic.
  if (buffer.includes(0)) {
    return { error: "Binary files cannot be read as text." };
  }
  return { content: buffer.toString("utf8"), truncated: false };
}
