import type { AppDatabase } from "@/db";
import { chatTools } from "@/lib/ai/tools";
import { listCustomTools } from "@/lib/ai/custom-tools/service";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import type { ToolSet } from "ai";

/**
 * Per-tool enable/disable for built-in chat tools.
 *
 * Storage: the settings-store key "toolToggles" holds
 * `{ disabled: string[] }` — only DISABLED tool names are stored, so the
 * default state (everything enabled) is implicit and a fresh install
 * writes nothing.
 *
 * Guarantees:
 *  - Only names that exist in the live registry can be stored; unknown
 *    names are dropped on read (a hand-edited DB row cannot disable a
 *    tool that no longer exists, nor inject arbitrary strings).
 *  - Protected tools (the interactive questionnaire) cannot be disabled
 *    at all: they are the model's only channel for asking the user a
 *    structured question, and silently removing them degrades every
 *    ambiguous conversation.
 *  - Read-time validation is idempotent: the sanitized list can be
 *    written back unchanged.
 */

/** Settings-store key holding the tool toggle state. */
export const TOOL_TOGGLES_KEY = "toolToggles";

/**
 * Tools that must never be disabled. ask_user_question is the model's
 * only way to pause and ask the user a structured question; disabling
 * it would silently make ambiguous requests un-clarifiable.
 */
export const PROTECTED_TOOLS: ReadonlySet<string> = new Set([
  "ask_user_question",
]);

/** Live registry of every built-in and dynamic custom tool name. */
export function knownToolNames(db?: AppDatabase): Set<string> {
  const names = new Set(Object.keys(chatTools));
  for (const customTool of listCustomTools(db)) {
    names.add(customTool.name);
  }
  return names;
}

export type ToolToggleState = {
  /** Names of disabled tools (validated, deduped, known-only). */
  disabled: string[];
};

/** Raw (unvalidated) shape of the stored settings value. */
function readRawDisabled(
  db?: AppDatabase
): unknown[] {
  const raw = getSettingDb(TOOL_TOGGLES_KEY, db);
  if (typeof raw !== "object" || raw === null) return [];
  const disabled = (raw as { disabled?: unknown }).disabled;
  return Array.isArray(disabled) ? disabled : [];
}

/**
 * The sanitized disabled list: only strings that (a) exist in the live
 * registry and (b) are not protected. Order preserved, duplicates
 * removed. Safe against any stored garbage.
 */
export function getDisabledTools(
  db?: AppDatabase
): string[] {
  const known = knownToolNames(db);
  const seen = new Set<string>();
  const disabled: string[] = [];
  for (const entry of readRawDisabled(db)) {
    if (typeof entry !== "string") continue;
    if (!known.has(entry)) continue;
    if (PROTECTED_TOOLS.has(entry)) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    disabled.push(entry);
  }
  return disabled;
}

/** Whether one tool is currently enabled (protected tools always true). */
export function isToolEnabled(
  toolName: string,
  db?: AppDatabase
): boolean {
  return !getDisabledTools(db).includes(toolName);
}

/**
 * Pure validator for a disabled-tool list: returns the sanitized list
 * (known names only, no protected tools, deduped, bounded) or null when
 * the input is unusable. Strict — a single bad entry rejects the whole
 * payload rather than silently dropping tools the caller believed they
 * had disabled.
 */
export function sanitizeDisabledTools(
  requested: unknown,
  db?: AppDatabase
): string[] | null {
  if (!Array.isArray(requested)) return null;
  if (requested.length > 100) return null;

  const known = knownToolNames(db);
  const seen = new Set<string>();
  const disabled: string[] = [];
  for (const entry of requested) {
    if (typeof entry !== "string") return null; // strict: reject, don't drop
    if (entry.length === 0 || entry.length > 128) return null;
    if (!known.has(entry)) return null; // unknown tool: reject the payload
    if (PROTECTED_TOOLS.has(entry)) return null; // not disableable
    if (seen.has(entry)) continue;
    seen.add(entry);
    disabled.push(entry);
  }
  return disabled;
}

/**
 * Validate and persist a new disabled list. Returns the sanitized list
 * that was stored, or null when the input is not a usable shape.
 *
 * Re-enabling a tool = omitting it from the list; re-enabling everything
 * = an empty list.
 */
export function saveDisabledTools(
  requested: unknown,
  db?: AppDatabase
): string[] | null {
  const disabled = sanitizeDisabledTools(requested, db);
  if (disabled === null) return null;
  setSettingsDb({ [TOOL_TOGGLES_KEY]: { disabled } }, db);
  return disabled;
}

/**
 * Filter a toolset for the chat request: every tool whose name is in the
 * disabled list is removed. Used by the chat route after merging
 * built-ins, skills, MCP and subagent tools so the policy applies to the
 * final, live toolset.
 */
export function filterToolsForChat<T extends ToolSet>(
  tools: T,
  db?: AppDatabase
): T {
  const disabled = new Set(getDisabledTools(db));
  if (disabled.size === 0) return tools;
  const filtered = { ...tools } as Record<string, unknown>;
  for (const name of disabled) delete filtered[name];
  return filtered as T;
}

/**
 * Filter a subagent's granted toolset. A disabled built-in is removed
 * from the grant too — the toggle is a global capability decision, not a
 * per-agent suggestion.
 */
export function filterToolsForSubagent<T extends ToolSet>(
  tools: T,
  db?: AppDatabase
): T {
  return filterToolsForChat(tools, db);
}
