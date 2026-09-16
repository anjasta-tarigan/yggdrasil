/**
 * Skills runtime — progressive disclosure for the chat agent.
 *
 * Step 1 (startup): a token-budgeted catalog of enabled skills
 * (name + description) is appended to the system prompt.
 * Step 2 (activation): the model calls `use_skill` to load a skill's
 * full SKILL.md body plus its bundled file list.
 * Step 3 (resources): `use_skill` with a `path` argument returns one bundled file.
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
import { syslog } from "@/lib/observability/log-store";
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

/** Rough token estimator.
 * Delegates language detection to `detectLanguage` (stopword-based heuristic)
 * to avoid duplicating Indonesian detection across catalog.ts, language.ts,
 * and context-budget.ts.
 *
 * English/Latin-script texts average ~4 chars/token.
 * Indonesian (Latin script, agglutinative) averages ~6 chars/token.
 * CJK scripts average ~2.5 chars/token.
 * Calibrated against GPT-4o tokenizer.
 */
import { detectLanguage } from "@/lib/text/language";

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const lang = detectLanguage(text);
  if (lang === "id") return Math.ceil(text.length / 6);     // Indonesian: ~6 chars/token
  if (lang === "unknown") {
    const nonAscii = (text.match(/[^\u0000-\u007F]/g) ?? []).length;
    if (nonAscii / text.length > 0.3) return Math.ceil(text.length / 2.5); // CJK
  }
  return Math.ceil(text.length / 4);                         // English default: ~4 chars/token
}

/** Greedily keep items while they fit the token budget.
 * When an item must be truncated, the cut lands on a sentence/paragraph boundary
 * (last period, newline, or 50% of remaining chars) to avoid mid-word/sentence
 * fragments that confuse the model — especially with Indonesian compound words.
 */
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
        const cpt = item.length === 0 ? 4 : item.length / estimateTokens(item);
        const cutAt = Math.floor(remainingTokens * cpt);
        // Find last sentence/paragraph boundary before cutAt to avoid mid-word truncation
        const lastPeriod = item.lastIndexOf(".", cutAt - 1);
        const lastNewline = item.lastIndexOf("\n", cutAt - 1);
        const bestBoundary = Math.max(lastPeriod, lastNewline);
        const safeCut = bestBoundary > 0 ? bestBoundary + 1 : Math.min(cutAt, Math.floor(item.length * 0.5));
        result.push(item.slice(0, safeCut).trimEnd() + "... [truncated]");
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
    syslog("warn", "skills", `Failed to list skills for prompt catalog: ${err instanceof Error ? err.message : String(err)}`);
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
    syslog("warn", "skills", `Failed to list plugin commands for catalog: ${err instanceof Error ? err.message : String(err)}`);
  }

  return (
    `\n\n<available_skills>\n` +
    "The following skills are installed. Each provides task-specific instructions loaded on demand.\n" +
    "When a task clearly matches a skill's description, call the 'use_skill' tool with its name BEFORE acting, then follow the loaded instructions. To read a specific bundled file referenced in the skill, call 'use_skill' again with both the skill name and the file path.\n" +
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
        "Load an installed skill by name. Without 'path', returns the full SKILL.md instructions and the list of bundled files. With 'path', returns the content of that specific bundled file (e.g. 'references/checklist.md'). Call this before acting whenever the current task matches a skill listed in <available_skills>.",
      inputSchema: z.object({
        name: z.string().describe("Exact skill name from the catalog"),
        path: z
          .string()
          .optional()
          .describe(
            "Optional relative path to a bundled file within the skill. Omit to load the main SKILL.md instructions."
          ),
      }),
      execute: async ({ name, path: filePath }) => {
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

        // If a specific file path is requested, return just that file's content
        if (filePath) {
          return readSkillFile(name, filePath, storeOpts);
        }

        // Otherwise return the full SKILL.md instructions and file list
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

    skills_catalog: tool({
      description:
        "List all installed skills with their enabled state, description, version, and bundled file count. Use this to discover available skills before calling use_skill.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listSkills(storeOpts);
        return {
          skills: rows.map((s) => ({
            name: s.name,
            description: s.description,
            enabled: s.enabled,
            version: s.version,
            fileCount: listSkillFiles(s.name, storeOpts).length,
          })),
        };
      },
    }),

    manage_skill: tool({
      description:
        "Create, update, or delete a skill. Use this to manage skills programmatically. For 'create': provide name, description, content (SKILL.md body), and optional files. For 'update': provide name and any fields to change (description, content, files). For 'delete': provide name. Plugin‑owned skills cannot be modified or deleted.",
      inputSchema: z.object({
        action: z.enum(["create", "update", "delete"]).describe("Action to perform"),
        name: z.string().describe("Skill name (lowercase letters, digits, hyphens)"),
        description: z.string().max(1024).optional().describe("Skill description (required for create)"),
        content: z.string().optional().describe("Markdown instruction body (required for create)"),
        files: z
          .array(
            z.object({
              path: z.string(),
              content: z.string(),
            })
          )
          .optional()
          .describe("Optional bundled resource files (for create/update)"),
      }),
      execute: async ({ action, name, description, content, files }) => {
        // Validate name
        if (!isValidSkillName(name)) {
          return {
            error: `Invalid skill name '${name}'. Use lowercase letters, digits and hyphens only (max 64 chars, no leading/trailing/consecutive hyphens).`,
          };
        }

        const existing = await getSkillByName(name, storeOpts);

        switch (action) {
          case "create": {
            if (existing) {
              return { error: `Skill '${name}' already exists. Use 'update' to modify it.` };
            }
            if (!description || !content) {
              return { error: "Create requires both 'description' and 'content'." };
            }
            const skillMd = composeSkillMd(name, description, content);
            const extraFiles = parseExtraFiles(files) ?? [];
            // Ensure a README.md exists; generate one if not provided
            const hasReadme = extraFiles.some(f => f.path === "README.md");
            if (!hasReadme) {
              const readmeContent = `# ${name}\n\n${description}\n\nSee SKILL.md for detailed instructions.\n`;
              extraFiles.push({ path: "README.md", content: readmeContent });
            }
            const allFiles: SkillFile[] = [
              { path: "SKILL.md", content: skillMd },
              ...extraFiles,
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
          }

          case "update": {
            if (!existing) {
              return { error: `Skill '${name}' does not exist.` };
            }
            if (existing.pluginId) {
              return { error: `Skill '${name}' belongs to a plugin; update the plugin instead.` };
            }
            // If no fields to update, return early
            if (description === undefined && content === undefined && files === undefined) {
              return { error: "Update requires at least one field to change (description, content, or files)." };
            }

            const body = getSkillBody(name, storeOpts);
            const nextDescription = description ?? existing.description;
            const nextBody = content ?? body?.body ?? "";
            const skillMd = composeSkillMd(name, nextDescription, nextBody);

            let allFiles: SkillFile[] = [{ path: "SKILL.md", content: skillMd }];
            if (files) {
              allFiles = allFiles.concat(parseExtraFiles(files) ?? []);
            } else {
              // Keep existing bundled files
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
                source: existing.source as { kind: "local" },
                version: existing.version ?? undefined,
              },
              storeOpts
            );
            if (!result.ok) return { error: result.error };
            return { updated: name, files: listSkillFiles(name, storeOpts) };
          }

          case "delete": {
            if (!existing) {
              return { error: `Skill '${name}' does not exist.` };
            }
            if (existing.pluginId) {
              return { error: `Skill '${name}' belongs to a plugin; uninstall the plugin instead.` };
            }
            const ok = await uninstallSkill(existing.id, storeOpts);
            return ok ? { deleted: name } : { error: "Delete failed." };
          }

          default:
            return { error: `Unknown action: ${action}` };
        }
      },
    }),
  };
}
