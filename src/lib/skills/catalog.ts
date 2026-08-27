/**
 * Skills runtime — progressive disclosure for the chat agent.
 *
 * Step 1 (startup): a token-budgeted catalog of enabled skills
 * (name + description) is appended to the system prompt.
 * Step 2 (activation): the model calls `use_skill` to load a skill's
 * full SKILL.md body plus its bundled file list.
 * Step 3 (resources): `read_skill_file` returns one bundled file.
 *
 * Skill-management tools (create/update/delete/list) let the assistant
 * author new skills mid-conversation, following the bundled
 * skill-creator skill's workflow.
 */

import fs from "node:fs";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { pluginCommands, plugins } from "@/db/schema";
import {
  SKILL_LISTING_DESCRIPTION_CAP,
  isValidSkillName,
  sanitizeSkillFiles,
  type SkillFile,
} from "./config";
import {
  getSkillBody,
  getSkillByName,
  installSkill,
  listSkillFiles,
  listSkills,
  readSkillFile,
  skillDir,
  uninstallSkill,
  type StoreOptions,
} from "./store";

/* ── Prompt catalog ──────────────────────────────────────────────── */

/** Rough token estimator (≈4 chars per token for English). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Greedily keep items while they fit the token budget. */
export function truncateToTokenBudget(
  items: string[],
  maxTokens: number
): string[] {
  const result: string[] = [];
  let currentTokens = 0;
  for (const item of items) {
    const itemTokens = estimateTokens(item);
    if (currentTokens + itemTokens <= maxTokens) {
      result.push(item);
      currentTokens += itemTokens;
    } else {
      const remainingTokens = maxTokens - currentTokens;
      if (remainingTokens > 20) {
        result.push(item.slice(0, remainingTokens * 4) + "... [truncated]");
      }
      break;
    }
  }
  return result;
}

export interface SkillsCatalogOptions extends StoreOptions {
  /** Token budget for the whole layer (default 800). */
  budgetTokens?: number;
}

/**
 * Build the `<available_skills>` system-prompt layer from enabled
 * skills, plus a one-line footer listing enabled plugin slash-commands
 * when any exist. Returns an empty string when nothing is installed.
 */
export async function buildSkillsCatalogBlock(
  options: SkillsCatalogOptions = {}
): Promise<string> {
  const db = options.db ?? defaultDb;
  const budget = options.budgetTokens ?? 800;

  let rows;
  try {
    rows = await listSkills({ db: options.db, enabledOnly: true });
  } catch (err) {
    console.warn("[skills] Failed to list skills for prompt catalog:", err);
    return "";
  }
  if (rows.length === 0) return "";

  const listings = rows.map((row) => {
    const description =
      row.description.length > SKILL_LISTING_DESCRIPTION_CAP
        ? row.description.slice(0, SKILL_LISTING_DESCRIPTION_CAP) + "…"
        : row.description;
    return `- ${row.name}: ${description}`;
  });

  const bounded = truncateToTokenBudget(listings, budget);
  if (bounded.length === 0) return "";

  let commandsFooter = "";
  try {
    const commands = await db
      .select({ name: pluginCommands.name, pluginId: pluginCommands.pluginId })
      .from(pluginCommands)
      .innerJoin(plugins, eq(pluginCommands.pluginId, plugins.id))
      .where(eq(plugins.enabled, true));
    if (commands.length > 0) {
      const names = commands.map((c) => `/${c.name}`).join(", ");
      commandsFooter = `\nSlash-commands from plugins (user-invocable prompt templates): ${names}`;
    }
  } catch (err) {
    console.warn("[skills] Failed to list plugin commands for catalog:", err);
  }

  return (
    `\n\n<available_skills>\n` +
    "The following skills are installed. Each provides task-specific instructions loaded on demand.\n" +
    "When a task clearly matches a skill's description, call the 'use_skill' tool with its name BEFORE acting, then follow the loaded instructions. Use 'read_skill_file' for referenced bundled files.\n" +
    bounded.join("\n") +
    commandsFooter +
    "\n</available_skills>"
  );
}

/* ── Tools ───────────────────────────────────────────────────────── */

/**
 * Build SKILL.md text from authoring inputs (used by create/update
 * tools and the UI wizard backend).
 */
export function composeSkillMd(
  name: string,
  description: string,
  body: string
): string {
  // JSON string escaping is a valid YAML double-quoted subset, so the
  // description survives colons, quotes and newlines intact.
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`;
}

function parseExtraFiles(
  files: Array<{ path: string; content: string }> | undefined
): SkillFile[] | undefined {
  if (!files) return undefined;
  return files.map((f) => ({ path: f.path, content: f.content }));
}

/**
 * Skill runtime + management tools. Spread into chatTools by the chat
 * route. All reads/writes go through the skill store; plugin-owned
 * skills are protected from direct mutation (manage via the plugin).
 */
export function createSkillTools(options: StoreOptions = {}) {
  const storeOpts = options;

  return {
    use_skill: tool({
      description:
        "Load the full instructions of an installed skill by name. Call this before acting whenever the current task matches a skill listed in <available_skills>. Returns the SKILL.md body plus the list of bundled files; use read_skill_file to read any referenced file.",
      inputSchema: z.object({
        name: z.string().describe("Exact skill name from the catalog"),
      }),
      execute: async ({ name }) => {
        const row = await getSkillByName(name, storeOpts);
        if (!row) {
          const all = await listSkills(storeOpts);
          return {
            error: `Skill '${name}' is not installed.`,
            available: all.map((s) => s.name),
          };
        }
        if (!row.enabled) {
          return { error: `Skill '${name}' is disabled.` };
        }
        const body = getSkillBody(name, storeOpts);
        if (!body) {
          return { error: `Skill '${name}' has no SKILL.md on disk.` };
        }
        return {
          name: row.name,
          description: row.description,
          instructions: body.body,
          truncated: body.truncated,
          files: listSkillFiles(name, storeOpts).filter(
            (f) => f !== "SKILL.md"
          ),
        };
      },
    }),

    read_skill_file: tool({
      description:
        "Read one bundled file of an installed skill (relative path as listed by use_skill). Use for references, checklists, templates or scripts the skill instructions point to.",
      inputSchema: z.object({
        name: z.string().describe("Skill name"),
        path: z
          .string()
          .describe("Relative file path within the skill, e.g. 'references/checklist.md'"),
      }),
      execute: async ({ name, path: filePath }) => {
        const row = await getSkillByName(name, storeOpts);
        if (!row) return { error: `Skill '${name}' is not installed.` };
        return readSkillFile(name, filePath, storeOpts);
      },
    }),

    list_installed_skills: tool({
      description:
        "List all installed skills with their enabled state and description. Cheaper than guessing names; use before create_skill to avoid duplicates.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listSkills(storeOpts);
        return {
          skills: rows.map((s) => ({
            name: s.name,
            description: s.description,
            enabled: s.enabled,
            version: s.version,
          })),
        };
      },
    }),

    create_skill: tool({
      description:
        "Create a new skill from scratch. Write a spec-valid name (lowercase letters/digits/hyphens), a description that states WHAT the skill does and WHEN to use it (be assertive: 'Use when…'), and concise step-by-step instructions. Optional extra files (references/, templates/, scripts/) keep the body lean. Follow the skill-creator skill's guidance when it is installed.",
      inputSchema: z.object({
        name: z
          .string()
          .describe("Skill name: lowercase letters, digits, hyphens; max 64 chars"),
        description: z
          .string()
          .max(1024)
          .describe("What the skill does and when to use it (max 1024 chars)"),
        content: z
          .string()
          .describe("Markdown instruction body for SKILL.md"),
        files: z
          .array(
            z.object({
              path: z.string().describe("Relative path, e.g. 'references/guide.md'"),
              content: z.string().describe("Full file content"),
            })
          )
          .optional()
          .describe("Optional bundled resource files"),
      }),
      execute: async ({ name, description, content, files }) => {
        if (!isValidSkillName(name)) {
          return {
            error: `Invalid skill name '${name}'. Use lowercase letters, digits and hyphens only (no leading/trailing/consecutive hyphens, max 64 chars).`,
          };
        }
        const existing = await getSkillByName(name, storeOpts);
        if (existing) {
          return {
            error: `Skill '${name}' already exists. Use update_skill to modify it or pick another name.`,
          };
        }
        const skillMd = composeSkillMd(name, description, content);
        const allFiles: SkillFile[] = [
          { path: "SKILL.md", content: skillMd },
          ...(parseExtraFiles(files) ?? []),
        ];
        const check = sanitizeSkillFiles(allFiles);
        if (!check.ok) return { error: check.error };
        const result = await installSkill(
          { name, files: allFiles, source: { kind: "local" } },
          storeOpts
        );
        if (!result.ok) return { error: result.error };
        return {
          created: name,
          description: result.row.description,
          files: listSkillFiles(name, storeOpts),
        };
      },
    }),

    update_skill: tool({
      description:
        "Update an existing skill's description, instruction body and/or bundled files. Omitted fields keep their current value. Plugin-provided skills cannot be edited.",
      inputSchema: z.object({
        name: z.string().describe("Existing skill name"),
        description: z.string().max(1024).optional(),
        content: z.string().optional().describe("New SKILL.md body"),
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          )
          .optional()
          .describe("Replacement set of bundled resource files (SKILL.md excluded)"),
      }),
      execute: async ({ name, description, content, files }) => {
        const row = await getSkillByName(name, storeOpts);
        if (!row) return { error: `Skill '${name}' is not installed.` };
        if (row.pluginId) {
          return {
            error: `Skill '${name}' belongs to a plugin; update the plugin instead.`,
          };
        }
        const body = getSkillBody(name, storeOpts);
        const nextDescription = description ?? row.description;
        const nextBody = content ?? body?.body ?? "";
        const skillMd = composeSkillMd(name, nextDescription, nextBody);

        let allFiles: SkillFile[] = [{ path: "SKILL.md", content: skillMd }];
        if (files) {
          allFiles = allFiles.concat(parseExtraFiles(files) ?? []);
        } else {
          // Keep existing bundled files verbatim directly from disk.
          const rootDir = skillDir(name, storeOpts);
          for (const rel of listSkillFiles(name, storeOpts)) {
            if (rel === "SKILL.md") continue;
            try {
              const fullPath = path.join(rootDir, rel);
              if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                allFiles.push({
                  path: rel,
                  content: fs.readFileSync(fullPath, "utf8"),
                });
              }
            } catch {
              // Ignore unreadable files
            }
          }
        }
        const result = await installSkill(
          {
            name,
            files: allFiles,
            source: (row.source as { kind: "local" }) ?? { kind: "local" },
            version: row.version ?? undefined,
          },
          storeOpts
        );
        if (!result.ok) return { error: result.error };
        return { updated: name, files: listSkillFiles(name, storeOpts) };
      },
    }),

    delete_skill: tool({
      description:
        "Permanently delete a skill the user asked to remove. Plugin-provided skills cannot be deleted directly (uninstall the plugin).",
      inputSchema: z.object({
        name: z.string().describe("Skill name to delete"),
      }),
      execute: async ({ name }) => {
        const row = await getSkillByName(name, storeOpts);
        if (!row) return { error: `Skill '${name}' is not installed.` };
        if (row.pluginId) {
          return {
            error: `Skill '${name}' belongs to a plugin; uninstall the plugin instead.`,
          };
        }
        const ok = await uninstallSkill(row.id, storeOpts);
        return ok ? { deleted: name } : { error: "Delete failed." };
      },
    }),
  };
}
