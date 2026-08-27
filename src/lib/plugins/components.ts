/**
 * Plugin component mapping — converts an installed plugin file tree
 * into Yggdrasil primitives:
 *
 *  - skills/<name>/SKILL.md (+ root SKILL.md)  → skills store
 *    (namespaced, plugin-owned, cascade with the plugin)
 *  - commands/*.md                             → plugin_commands rows
 *    (chat slash-command templates)
 *  - .mcp.json / manifest mcpServers           → MCP server registry
 *    (registered DISABLED; the user enables servers from the MCP page)
 *  - hooks / output-styles / themes / lsp / monitors → ignored
 *    (Claude Code runtime-specific; never parsed for execution)
 */

import { parse as parseYaml } from "yaml";
import { db as defaultDb, type AppDatabase } from "@/db";
import { pluginCommands } from "@/db/schema";
import {
  createMcpServerId,
  MCP_SERVERS_KEY,
  MAX_MCP_SERVERS,
  sanitizeMcpServerConfig,
  sanitizeMcpServerList,
  type McpServerConfig,
} from "@/lib/ai/mcp/config";
import { getSettingDb, setSettingsDb } from "@/lib/settings-service";
import {
  setSkillMdName,
  slugifySkillName,
  splitFrontmatter,
} from "@/lib/skills/config";
import { getSkillByName, installSkill, type StoreOptions } from "@/lib/skills/store";

export interface ComponentSummary {
  skills: Array<{ installedName: string; sourceName: string }>;
  commands: Array<{ name: string; description?: string }>;
  mcpServers: Array<{ id: string; name: string }>;
  ignored: string[];
  skipped: string[];
}

export interface MapComponentsInput {
  pluginId: string;
  pluginName: string;
  marketplaceName: string;
  /** Installed plugin file tree (path → content). */
  files: Map<string, string>;
  db?: AppDatabase;
  /** Skills store override (tests). */
  skillsStore?: StoreOptions;
}

interface PluginManifest {
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  skills?: string | string[];
  commands?: string | string[];
  mcpServers?: string | Record<string, unknown>;
  hooks?: unknown;
  outputStyles?: unknown;
  lspServers?: unknown;
  experimental?: Record<string, unknown>;
}

function parsePluginManifest(files: Map<string, string>): PluginManifest | null {
  const raw = files.get(".claude-plugin/plugin.json");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function asPathList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.replace(/^\.\//, "").replace(/\/+$/, ""));
}

/** Discover skill directories in the tree: [{ dirName, dirPath }]. */
function discoverSkillDirs(
  files: Map<string, string>,
  manifest: PluginManifest | null
): Array<{ dirName: string; dirPath: string }> {
  const found = new Map<string, string>(); // dirPath → dirName

  const record = (skillMdPath: string) => {
    const dirPath = skillMdPath.slice(0, -"SKILL.md".length).replace(/\/+$/, "");
    const segments = dirPath ? dirPath.split("/") : [];
    const dirName = segments[segments.length - 1] ?? "";
    if (dirPath && !found.has(dirPath)) found.set(dirPath, dirName);
  };

  // Default locations: root SKILL.md and skills/<name>/SKILL.md.
  for (const filePath of files.keys()) {
    if (filePath !== "SKILL.md" && !filePath.endsWith("/SKILL.md")) continue;
    if (filePath === "SKILL.md") continue; // handled below
    const relative = filePath.slice(0, -"/SKILL.md".length);
    const segments = relative.split("/").filter(Boolean);
    if (segments[0] === "skills" && segments.length === 2) {
      record(filePath);
    }
  }

  // Custom skill directories from the manifest.
  for (const custom of asPathList(manifest?.skills)) {
    for (const filePath of files.keys()) {
      if (
        (filePath === `${custom}/SKILL.md` || filePath.endsWith("/SKILL.md")) &&
        filePath.startsWith(`${custom}/`)
      ) {
        const relative = filePath.slice(custom.length + 1, -"/SKILL.md".length);
        if (relative && !relative.includes("/")) record(filePath);
        else if (filePath === `${custom}/SKILL.md`) record(filePath);
      }
    }
  }

  const dirs = [...found.entries()].map(([dirPath, dirName]) => ({ dirName, dirPath }));

  // Root SKILL.md counts as a skill named after the plugin.
  if (files.has("SKILL.md")) dirs.unshift({ dirName: "", dirPath: "" });
  return dirs;
}

/** Extract the files of one skill subfolder as store-ready files. */
function collectSkillFiles(
  files: Map<string, string>,
  dirPath: string
): Array<{ path: string; content: string }> {
  const prefix = dirPath ? `${dirPath}/` : "";
  const out: Array<{ path: string; content: string }> = [];
  for (const [filePath, content] of files) {
    if (prefix) {
      if (filePath.startsWith(prefix)) {
        out.push({ path: filePath.slice(prefix.length), content });
      }
    } else {
      // For root-level skill, exclude files in skills/ directory if any
      if (!filePath.startsWith("skills/") && !filePath.startsWith(".claude-plugin/")) {
        out.push({ path: filePath, content });
      }
    }
  }
  return out;
}

/** Convert one Claude Code MCP server definition to our config shape. */
function convertMcpServer(
  name: string,
  definition: Record<string, unknown>,
  pluginName: string
): McpServerConfig | null {
  const base = {
    id: createMcpServerId(),
    name: `${pluginName}:${name}`.slice(0, 128),
    enabled: false, // plugins never auto-enable MCP servers
  };

  if (typeof definition.command === "string") {
    return sanitizeMcpServerConfig({
      ...base,
      transport: "stdio",
      command: definition.command,
      args: Array.isArray(definition.args) ? definition.args : undefined,
      env:
        typeof definition.env === "object" && definition.env !== null
          ? definition.env
          : undefined,
    });
  }

  const type = definition.type === "sse" ? "sse" : "http";
  if (typeof definition.url === "string") {
    return sanitizeMcpServerConfig({
      ...base,
      transport: type,
      url: definition.url,
      headers:
        typeof definition.headers === "object" && definition.headers !== null
          ? definition.headers
          : undefined,
    });
  }
  return null;
}

/** Read the mcpServers map from .mcp.json or the manifest field. */
function discoverMcpServers(
  files: Map<string, string>,
  manifest: PluginManifest | null
): Record<string, Record<string, unknown>> | null {
  let raw: string | undefined;
  if (typeof manifest?.mcpServers === "string") {
    raw = files.get(manifest.mcpServers.replace(/^\.\//, ""));
  } else if (manifest?.mcpServers && typeof manifest.mcpServers === "object") {
    const inline = manifest.mcpServers as Record<string, unknown>;
    if (inline.mcpServers && typeof inline.mcpServers === "object") {
      return inline.mcpServers as Record<string, Record<string, unknown>>;
    }
    return inline as Record<string, Record<string, unknown>>;
  } else {
    raw = files.get(".mcp.json");
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
      return servers as Record<string, Record<string, unknown>>;
    }
    return null;
  } catch {
    return null;
  }
}

interface ParsedCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  content: string;
}

/** Parse one command .md file (frontmatter description/argument-hint). */
function parseCommandFile(fileName: string, text: string): ParsedCommand {
  const { yamlBlock, body } = splitFrontmatter(text);
  let description: string | undefined;
  let argumentHint: string | undefined;
  if (yamlBlock) {
    try {
      const fm = parseYaml(yamlBlock);
      if (typeof fm === "object" && fm !== null && !Array.isArray(fm)) {
        const record = fm as Record<string, unknown>;
        if (typeof record.description === "string") description = record.description;
        const hint = record["argument-hint"];
        if (typeof hint === "string") {
          argumentHint = hint;
        } else if (Array.isArray(hint)) {
          // YAML parses a bare "[target]" as a flow sequence; restore
          // the bracketed hint form users write.
          argumentHint = `[${hint.map(String).join(" ")}]`;
        }
      }
    } catch {
      // Invalid frontmatter: treat the whole file as content.
    }
  }
  return { name: fileName.replace(/\.md$/i, ""), description, argumentHint, content: body };
}

/**
 * Map an installed plugin tree into Yggdrasil stores. Idempotent-ish:
 * call once per install (re installs should uninstall first).
 */
export async function mapPluginComponents(
  input: MapComponentsInput
): Promise<ComponentSummary> {
  const db = input.db ?? defaultDb;
  const { files, pluginId, pluginName, marketplaceName } = input;
  const summary: ComponentSummary = {
    skills: [],
    commands: [],
    mcpServers: [],
    ignored: [],
    skipped: [],
  };

  const manifest = parsePluginManifest(files);

  /* ── Skills ── */
  const skillDirs = discoverSkillDirs(files, manifest);
  for (const { dirName, dirPath } of skillDirs) {
    const skillFiles = collectSkillFiles(files, dirPath);
    if (!skillFiles.some((f) => f.path === "SKILL.md")) continue;

    const baseName = dirName
      ? slugifySkillName(`${pluginName}-${dirName}`)
      : slugifySkillName(pluginName);
    if (!baseName) {
      summary.skipped.push(`skill '${dirName || "root"}': unusable name`);
      continue;
    }

    // Collision-safe name: never shadow another plugin's or the
    // user's own skills (installSkill replaces same-name skills, so
    // ownership is checked up front).
    let candidate = baseName;
    let installed = false;
    for (let attempt = 2; attempt <= 10; attempt++) {
      const existing = await getSkillByName(candidate, input.skillsStore);
      if (existing && existing.pluginId !== pluginId) {
        candidate = `${baseName}-${attempt}`.slice(0, 64).replace(/-+$/g, "");
        continue;
      }
      // Align the frontmatter name with the (possibly namespaced or
      // collision-renamed) install name.
      const renamedFiles = skillFiles.map((f) =>
        f.path === "SKILL.md" ? { ...f, content: setSkillMdName(f.content, candidate) } : f
      );
      const result = await installSkill(
        {
          name: candidate,
          files: renamedFiles,
          source: {
            kind: "plugin",
            plugin: pluginName,
            marketplace: marketplaceName,
            skill: dirName || "root",
          },
          version: manifest?.version,
          pluginId,
        },
        input.skillsStore
      );
      if (result.ok) {
        summary.skills.push({ installedName: candidate, sourceName: dirName || "root" });
        installed = true;
        break;
      }
      summary.skipped.push(`skill '${dirName || "root"}': ${result.error}`);
      break;
    }
    if (!installed && !summary.skipped.some((s) => s.startsWith(`skill '${dirName || "root"}'`))) {
      summary.skipped.push(`skill '${dirName || "root"}': name collisions exhausted`);
    }
  }

  /* ── Commands ── */
  const commandPaths = new Set<string>();
  for (const filePath of files.keys()) {
    if (/^commands\/[^/]+\.md$/i.test(filePath)) commandPaths.add(filePath);
  }
  for (const custom of asPathList(manifest?.commands)) {
    if (custom.endsWith(".md") && files.has(custom)) {
      commandPaths.add(custom);
    } else {
      for (const filePath of files.keys()) {
        if (filePath.startsWith(`${custom}/`) && filePath.endsWith(".md")) {
          commandPaths.add(filePath);
        }
      }
    }
  }
  for (const filePath of [...commandPaths].sort()) {
    const parsed = parseCommandFile(filePath.split("/").pop() ?? filePath, files.get(filePath) ?? "");
    const name = `${pluginName}:${parsed.name}`.slice(0, 128);
    const [row] = await db
      .insert(pluginCommands)
      .values({
        id: `pcmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        pluginId,
        name,
        description: parsed.description,
        argumentHint: parsed.argumentHint,
        content: parsed.content,
      })
      .returning();
    summary.commands.push({ name: row.name, description: row.description ?? undefined });
  }

  /* ── MCP servers ── */
  const serverDefs = discoverMcpServers(files, manifest);
  if (serverDefs && Object.keys(serverDefs).length > 0) {
    const existingRaw = getSettingDb(MCP_SERVERS_KEY, db);
    const existing = sanitizeMcpServerList(existingRaw) ?? [];
    const added: McpServerConfig[] = [];
    for (const [serverName, definition] of Object.entries(serverDefs)) {
      if (existing.length + added.length >= MAX_MCP_SERVERS) {
        summary.skipped.push(`mcp '${serverName}': server registry full`);
        continue;
      }
      const config = convertMcpServer(serverName, definition ?? {}, pluginName);
      if (!config) {
        summary.skipped.push(`mcp '${serverName}': unsupported definition`);
        continue;
      }
      added.push(config);
      summary.mcpServers.push({ id: config.id, name: config.name });
    }
    if (added.length > 0) {
      setSettingsDb({ [MCP_SERVERS_KEY]: [...existing, ...added] }, db);
    }
  }

  /* ── Ignored components (reported, never executed) ── */
  if (manifest?.hooks || [...files.keys()].some((p) => p.startsWith("hooks/"))) {
    summary.ignored.push("hooks");
  }
  if (manifest?.outputStyles || [...files.keys()].some((p) => p.startsWith("output-styles/"))) {
    summary.ignored.push("output-styles");
  }
  if (manifest?.lspServers || [...files.keys()].some((p) => p.startsWith(".lsp/") || p === ".lsp.json")) {
    summary.ignored.push("lsp");
  }
  if (
    manifest?.experimental &&
    (manifest.experimental.themes || manifest.experimental.monitors)
  ) {
    summary.ignored.push("experimental");
  }
  if ([...files.keys()].some((p) => p.startsWith("agents/"))) {
    summary.ignored.push("agents");
  }

  return summary;
}
