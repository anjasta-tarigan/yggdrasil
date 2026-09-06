import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { zipSync, strToU8 } from "fflate";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";
import { MCP_SERVERS_KEY, sanitizeMcpServerList } from "@/lib/ai/mcp/config";
import { getSettingDb } from "@/lib/settings-service";
import { listSkills } from "@/lib/skills/store";
import {
  parseMarketplaceInput,
  validateMarketplaceManifest,
  addMarketplace,
  seedOfficialMarketplace,
  listMarketplaces,
} from "../marketplace";
import { resolvePluginSource, writePluginTree, pluginDir } from "../installer";
import { mapPluginComponents } from "../components";
import {
  installPlugin,
  listEnabledCommands,
  setPluginEnabled,
  uninstallPlugin,
} from "../lifecycle";

/* ── fixtures ────────────────────────────────────────────────────── */

const MANIFEST = {
  name: "test-marketplace",
  description: "Test catalog",
  owner: { name: "Test Owner" },
  plugins: [
    {
      name: "demo-plugin",
      description: "Demo plugin",
      category: "development",
      source: "./plugins/demo-plugin",
    },
  ],
};

const PLUGIN_SKILL_MD = `---
name: demo-plugin-review
description: Review code like the demo plugin wants.
---

Review steps here.
`;

const PLUGIN_FILES: Record<string, string> = {
  ".claude-plugin/plugin.json": JSON.stringify({
    name: "demo-plugin",
    version: "1.2.3",
    hooks: "./hooks/hooks.json",
  }),
  "skills/review/SKILL.md": PLUGIN_SKILL_MD,
  "commands/check.md":
    "---\ndescription: Run the demo check\nargument-hint: [target]\n---\nCheck $ARGUMENTS now.",
  ".mcp.json": JSON.stringify({
    mcpServers: {
      demo: { command: "demo-server", args: ["--flag"], env: { KEY: "value" } },
    },
  }),
  "hooks/hooks.json": "{}",
  "README.md": "readme",
};

function treeResponseForFiles(files: Record<string, string>, prefix = "") {
  return JSON.stringify({
    tree: Object.keys(files).map((p) => ({
      path: prefix ? `${prefix}/${p}` : p,
      type: "blob",
    })),
  });
}

function mockFetchForMarketplace(routes: Record<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.startsWith(pattern)) return new Response(body, { status: 200 });
    }
    return new Response(`no route: ${url}`, { status: 404 });
  }) as typeof fetch;
}

/* ── tests ───────────────────────────────────────────────────────── */

describe("marketplace manifest validation", () => {
  it("accepts a valid manifest", () => {
    const res = validateMarketplaceManifest(MANIFEST);
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.name).toBe("test-marketplace");
      expect(res.plugins).toHaveLength(1);
    }
  });

  it("rejects missing name, plugins and entry fields", () => {
    expect("error" in validateMarketplaceManifest({})).toBe(true);
    expect("error" in validateMarketplaceManifest({ name: "x" })).toBe(true);
    expect(
      "error" in validateMarketplaceManifest({ name: "x", plugins: [{ name: "p" }] })
    ).toBe(true);
    expect("error" in validateMarketplaceManifest(null)).toBe(true);
  });

  it("parses marketplace input forms", () => {
    expect(parseMarketplaceInput("anthropics/claude-plugins-official")).toEqual({
      kind: "github",
      owner: "anthropics",
      repo: "claude-plugins-official",
      ref: undefined,
    });
    expect(
      parseMarketplaceInput("https://github.com/anthropics/claude-plugins-official")
    ).toMatchObject({ kind: "github", owner: "anthropics" });
    expect(parseMarketplaceInput("https://gitlab.com/x/y")).toEqual({
      kind: "git-url",
      url: "https://gitlab.com/x/y",
    });
    expect(parseMarketplaceInput("nonsense")).toBeNull();
  });
});

describe("resolvePluginSource", () => {
  const ghMarketplace = { kind: "github", owner: "acme", repo: "catalog" } as const;

  it("resolves relative sources inside the marketplace repo", async () => {
    const routes: Record<string, string> = {
      "https://api.github.com/repos/acme/catalog/git/trees/": treeResponseForFiles(
        PLUGIN_FILES,
        "plugins/demo-plugin"
      ),
    };
    for (const [p, content] of Object.entries(PLUGIN_FILES)) {
      routes[`https://raw.githubusercontent.com/acme/catalog/HEAD/plugins/demo-plugin/${p}`] =
        content;
    }
    const fetchImpl = mockFetchForMarketplace(routes);
    const res = await resolvePluginSource("./plugins/demo-plugin", ghMarketplace, {
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.tree.files.get("skills/review/SKILL.md")).toBe(PLUGIN_SKILL_MD);
      expect(res.tree.files.size).toBe(Object.keys(PLUGIN_FILES).length);
    }
  });

  it("rejects npm and command sources as unsupported", async () => {
    const npm = await resolvePluginSource(
      { source: "npm", package: "x" },
      ghMarketplace
    );
    expect(npm.ok).toBe(false);
    expect(npm.ok === false && npm.unsupported).toBe(true);

    const cmd = await resolvePluginSource(
      { source: "command", command: "evil" },
      ghMarketplace
    );
    expect(cmd.ok).toBe(false);
  });

  it("rejects non-GitHub git sources", async () => {
    const res = await resolvePluginSource(
      { source: "git-subdir", url: "https://gitlab.com/a/b.git", path: "x" },
      ghMarketplace
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.unsupported).toBe(true);
  });

  it("extracts archive sources with zip guards", async () => {
    const zip = zipSync({
      "SKILL.md": strToU8(PLUGIN_SKILL_MD),
      "commands/hi.md": strToU8("hi"),
    });
    const fetchImpl = (async () =>
      new Response(new Uint8Array(zip), {
        status: 200,
        headers: { "content-type": "application/zip" },
      })) as typeof fetch;
    const res = await resolvePluginSource(
      { source: "archive", url: "https://github.com/acme/thing/releases/download/v1/plugin.zip" },
      ghMarketplace,
      { fetchImpl }
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tree.files.has("SKILL.md")).toBe(true);
  });
});

describe("writePluginTree", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes files and rejects bad names", () => {
    const files = new Map(Object.entries(PLUGIN_FILES));
    const count = writePluginTree("test-marketplace", "demo-plugin", { files }, { root });
    expect(count).toBe(files.size);
    expect(
      fs.existsSync(path.join(root, "test-marketplace", "demo-plugin", ".mcp.json"))
    ).toBe(true);
    expect(() =>
      writePluginTree("../evil", "demo", { files: new Map([["a.md", "x"]]) }, { root })
    ).toThrow();
  });
});

describe("mapPluginComponents", () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  let skillsRootDir: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema }) as AppDatabase;
    skillsRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-map-"));
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(skillsRootDir, { recursive: true, force: true });
  });

  it("maps skills, commands, MCP servers and ignores hooks", async () => {
    const pluginId = "plug-test";
    sqlite
      .prepare(
        "INSERT INTO plugin_marketplaces (id, name, source) VALUES (?, ?, ?)"
      )
      .run("mkt-test", "test-marketplace", "{}");
    sqlite
      .prepare(
        "INSERT INTO plugins (id, marketplace_id, name, enabled, components) VALUES (?, ?, ?, 1, '{}')"
      )
      .run(pluginId, "mkt-test", "demo-plugin");

    const summary = await mapPluginComponents({
      pluginId,
      pluginName: "demo-plugin",
      marketplaceName: "test-marketplace",
      files: new Map(Object.entries(PLUGIN_FILES)),
      db,
      skillsStore: { db, root: skillsRootDir },
    });

    expect(summary.skills.map((s) => s.installedName)).toEqual(["demo-plugin-review"]);
    expect(summary.commands.map((c) => c.name)).toEqual(["demo-plugin:check"]);
    expect(summary.mcpServers).toHaveLength(1);
    expect(summary.ignored).toContain("hooks");

    // Skill is plugin-owned and on disk.
    const rows = await listSkills({ db, root: skillsRootDir });
    expect(rows).toHaveLength(1);
    expect(rows[0].pluginId).toBe(pluginId);
    expect(fs.existsSync(path.join(skillsRootDir, "demo-plugin-review", "SKILL.md"))).toBe(
      true
    );

    // MCP server appended disabled.
    const servers = sanitizeMcpServerList(getSettingDb(MCP_SERVERS_KEY, db)) ?? [];
    expect(servers).toHaveLength(1);
    expect(servers[0].enabled).toBe(false);
    expect(servers[0].transport).toBe("stdio");
    expect(servers[0].command).toBe("demo-server");
    expect(servers[0].name).toBe("demo-plugin:demo");

    // Command row parsed frontmatter.
    const commands = await listEnabledCommands({ db });
    expect(commands[0].description).toBe("Run the demo check");
    expect(commands[0].argumentHint).toBe("[target]");
  });

  it("never shadows user skills with plugin skill names", async () => {
    const pluginId = "plug-2";
    sqlite
      .prepare("INSERT INTO plugin_marketplaces (id, name, source) VALUES (?, ?, ?)")
      .run("mkt-2", "test-marketplace", "{}");
    sqlite
      .prepare(
        "INSERT INTO plugins (id, marketplace_id, name, enabled, components) VALUES (?, ?, ?, 1, '{}')"
      )
      .run(pluginId, "mkt-2", "demo-plugin");

    // User already owns the would-be name.
    sqlite
      .prepare(
        "INSERT INTO skills (id, name, description, enabled) VALUES (?, ?, ?, 1)"
      )
      .run("skill-user", "demo-plugin-review", "user skill");

    const summary = await mapPluginComponents({
      pluginId,
      pluginName: "demo-plugin",
      marketplaceName: "test-marketplace",
      files: new Map(Object.entries(PLUGIN_FILES)),
      db,
      skillsStore: { db, root: skillsRootDir },
    });

    expect(summary.skills[0].installedName).toBe("demo-plugin-review-2");
    const rows = await listSkills({ db, root: skillsRootDir });
    expect(rows).toHaveLength(2);
  });

  it("does not repeat the plugin name when the skill dir matches it", async () => {
    const pluginId = "plug-3";
    sqlite
      .prepare("INSERT INTO plugin_marketplaces (id, name, source) VALUES (?, ?, ?)")
      .run("mkt-3", "test-marketplace", "{}");
    sqlite
      .prepare(
        "INSERT INTO plugins (id, marketplace_id, name, enabled, components) VALUES (?, ?, ?, 1, '{}')"
      )
      .run(pluginId, "mkt-3", "skill-creator");

    const files = new Map<string, string>([
      [".claude-plugin/plugin.json", JSON.stringify({ name: "skill-creator" })],
      ["skills/skill-creator/SKILL.md", PLUGIN_SKILL_MD],
    ]);

    const summary = await mapPluginComponents({
      pluginId,
      pluginName: "skill-creator",
      marketplaceName: "test-marketplace",
      files,
      db,
      skillsStore: { db, root: skillsRootDir },
    });

    expect(summary.skills.map((s) => s.installedName)).toEqual(["skill-creator"]);
  });
});

describe("plugin lifecycle (install → toggle → uninstall)", () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  let skillsRootDir: string;
  let pluginsRootDir: string;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema }) as AppDatabase;
    skillsRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-life-"));
    pluginsRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-life-"));
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(skillsRootDir, { recursive: true, force: true });
    fs.rmSync(pluginsRootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function routesForInstall(): Record<string, string> {
    const routes: Record<string, string> = {
      "https://raw.githubusercontent.com/acme/catalog/HEAD/.claude-plugin/marketplace.json":
        JSON.stringify(MANIFEST),
      "https://api.github.com/repos/acme/catalog/git/trees/": treeResponseForFiles(
        PLUGIN_FILES,
        "plugins/demo-plugin"
      ),
    };
    for (const [p, content] of Object.entries(PLUGIN_FILES)) {
      routes[`https://raw.githubusercontent.com/acme/catalog/HEAD/plugins/demo-plugin/${p}`] =
        content;
    }
    return routes;
  }

  it("seeds the official marketplace once", () => {
    seedOfficialMarketplace({ db });
    seedOfficialMarketplace({ db });
    const rows = listMarketplaces({ db });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("claude-plugins-official");
  });

  it("adds a marketplace from a GitHub repo", async () => {
    const fetchImpl = mockFetchForMarketplace({
      "https://raw.githubusercontent.com/acme/catalog/HEAD/.claude-plugin/marketplace.json":
        JSON.stringify(MANIFEST),
    });
    const res = await addMarketplace("acme/catalog", { db, fetchImpl });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.row.name).toBe("test-marketplace");
      expect(res.manifest.plugins).toHaveLength(1);
    }
  });

  it("installs, toggles and uninstalls a plugin end-to-end", async () => {
    const fetchImpl = mockFetchForMarketplace(routesForInstall());
    const add = await addMarketplace("acme/catalog", { db, fetchImpl });
    expect(add.ok).toBe(true);
    if (!add.ok) return;

    const opts = {
      db,
      root: pluginsRootDir,
      skillsStore: { db, root: skillsRootDir },
      fetchOptions: { fetchImpl },
    };

    const install = await installPlugin(add.row.id, "demo-plugin", opts);
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    expect(install.components.skills).toHaveLength(1);
    expect(install.components.commands).toHaveLength(1);
    expect(install.components.mcpServers).toHaveLength(1);
    expect(
      fs.existsSync(pluginDir("test-marketplace", "demo-plugin", { root: pluginsRootDir }))
    ).toBe(true);

    // Toggle off disables the plugin's skills and hides its commands.
    const disabled = setPluginEnabled(install.row.id, false, { db });
    expect(disabled?.enabled).toBe(false);
    const skillRows = await listSkills({ db, root: skillsRootDir });
    expect(skillRows.every((s) => s.enabled === false)).toBe(true);
    expect(await listEnabledCommands({ db })).toHaveLength(0);

    setPluginEnabled(install.row.id, true, { db });
    expect(await listEnabledCommands({ db })).toHaveLength(1);

    // Uninstall removes rows, tree, skills and MCP entries.
    expect(await uninstallPlugin(install.row.id, opts)).toBe(true);
    expect(
      fs.existsSync(pluginDir("test-marketplace", "demo-plugin", { root: pluginsRootDir }))
    ).toBe(false);
    expect(await listSkills({ db, root: skillsRootDir })).toHaveLength(0);
    expect(sanitizeMcpServerList(getSettingDb(MCP_SERVERS_KEY, db)) ?? []).toHaveLength(0);
    expect(await listEnabledCommands({ db })).toHaveLength(0);
  });

  it("reports unsupported plugin sources without writing anything", async () => {
    const manifest = {
      ...MANIFEST,
      plugins: [{ name: "npm-plugin", source: { source: "npm", package: "x" } }],
    };
    const fetchImpl = mockFetchForMarketplace({
      "https://raw.githubusercontent.com/acme/catalog/HEAD/.claude-plugin/marketplace.json":
        JSON.stringify(manifest),
    });
    const add = await addMarketplace("acme/catalog", { db, fetchImpl });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const install = await installPlugin(add.row.id, "npm-plugin", {
      db,
      root: pluginsRootDir,
      skillsStore: { db, root: skillsRootDir },
      fetchOptions: { fetchImpl },
    });
    expect(install.ok).toBe(false);
    expect(install.ok === false && install.unsupported).toBe(true);
  });
});
