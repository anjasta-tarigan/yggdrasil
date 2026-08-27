# Plugins & Skills Features Design

## Overview
Adds two extension systems to Yggdrasil, modeled on the research in `docs/research/RESEARCH-plugins-skills.md`:

1. **Skills** — Agent Skills (agentskills.io spec) installed from **skills.sh**, **ClawHub**, arbitrary **GitHub repos**, or created locally (manual wizard + Anthropic's official `skill-creator` skill driving in-chat creation). Skills are loaded into the chat agent with progressive disclosure: a token-budgeted catalog (name+description) in the system prompt, full bodies on demand via a `use_skill` tool, bundled files via `read_skill_file`.
2. **Plugins** — Claude Code plugins installed from **plugin marketplaces** (`.claude-plugin/marketplace.json` catalogs, Anthropic's official marketplace pre-seeded, third-party marketplaces addable by repo URL). Consumed components: plugin **skills** → skills system, **commands** → chat slash-command prompt templates, **MCP servers** → existing MCP registry (registered disabled). Hooks/themes/LSP/monitors are ignored (never executed).

Both systems are provider-agnostic (work with every configured chat provider) and persist to SQLite + the local filesystem under `data/`.

## Goals
- Install/uninstall skills from ClawHub (public no-auth API + ZIP download), skills.sh (public search API + GitHub resolution), and direct GitHub repos (`owner/repo` or URL, pick from discovered `SKILL.md` files).
- Create skills two ways: a manual "New skill" wizard validated against the agentskills.io spec, and an AI flow — bundled `skill-creator` skill + `create_skill`/`update_skill`/`delete_skill` server tools so the assistant authors skills mid-conversation.
- Enable/disable/delete installed skills; view SKILL.md content and bundled files in the UI.
- Manage plugin marketplaces (official Anthropic marketplace pre-seeded; add/remove by GitHub repo or git URL), browse their catalogs, and install plugins with source resolution (relative path, `github`, `git-subdir`, `url` git, `archive` zip; `npm`/`command` sources unsupported and reported).
- Map installed plugin components into Yggdrasil: skills (namespaced), commands (slash-command templates), MCP servers (registered disabled, user enables from the MCP page). Enable/disable/uninstall plugins wholesale.
- Progressive-disclosure runtime: skill catalog layer in the synthesized system prompt (budgeted), `use_skill` + `read_skill_file` tools, skill-management tools.
- Hard security boundaries: HTTPS host allowlist, no redirects, archive/zip path-traversal guards, size and file-count caps, trust warnings before install, no execution of third-party code from plugins/skills.

## Architecture

### Storage layout
```
data/
  skills/<skill-name>/          # installed + built-in skills (SKILL.md + bundled files)
  plugins/<marketplace>/<plugin>/   # installed plugin trees (verbatim)
  yggdrasil.db                  # registry metadata (new tables below)
```
Skill/plugin *content* lives on disk (ecosystem-compatible folders, easy export); *registry metadata* (provenance, version, enabled) lives in SQLite.

### DB schema additions (`src/db/schema.ts` + idempotent CREATE in `src/db/init.ts`)
- `skills` — `id` (pk), `name` (unique, spec-valid), `description`, `version?`, `enabled` (bool), `source` (json: `{ kind: "clawhub"|"skillssh"|"github"|"local"|"plugin"|"builtin", ...refs }`), `pluginId?` (fk → plugins.id, cascade), `createdAt`, `updatedAt`.
- `plugin_marketplaces` — `id`, `name` (unique, from manifest), `source` (json: `{ kind: "github"|"git-url", repo/url, ref? }`), `description?`, `ownerName?`, `lastSyncedAt?`, `createdAt`.
- `plugins` — `id`, `marketplaceId` (fk, cascade), `name`, `displayName?`, `description?`, `version?`, `category?`, `enabled` (bool), `source` (json snapshot of marketplace entry source), `components` (json summary: `{ skills: n, commands: n, mcpServers: n, ignored: [...] }`), `installedAt`, `updatedAt`.
- `plugin_commands` — `id`, `pluginId` (fk, cascade), `name`, `description?`, `content` (the .md body), `argumentHint?`.

### Skills core (`src/lib/skills/`)
- `spec.ts` — pure module: `parseSkillMd(text)` (YAML frontmatter via `yaml` pkg + body), `validateSkillName` (≤64 chars, `[a-z0-9-]`, no leading/trailing/consecutive hyphens), description ≤1024 chars, `sanitizeSkillFiles` (path traversal guards: relative POSIX paths only, no `..`, no absolute, no symlinks, bounded count/size). Shared server/client.
- `store.ts` — disk + DB CRUD: `installSkill({ name, files, source })` (writes folder atomically: temp dir → rename; upserts row), `uninstallSkill(id)` (removes folder + row; plugin-owned skills cascade with plugin), `setSkillEnabled`, `listSkills`, `readSkillFile(name, path)` (bounded read), `getSkillBody(name)`.
- `catalog.ts` — builds the prompt catalog block from enabled skills (`<available_skills>` entries: name + description, truncated per spec at ~1536 chars each, whole layer token-budgeted ~800 tokens) and the `use_skill`/`read_skill_file` tool definitions.
- `builtin.ts` — seeds built-in skills on first boot when missing (network-permitted): `skill-creator` from `anthropics/skills` (tracked as `source.kind = "builtin"`).

### Registries (`src/lib/skills/registries/`)
- `http.ts` — shared guarded fetch: HTTPS-only host allowlist (`github.com`, `api.github.com`, `raw.githubusercontent.com`, `codeload.github.com`, `clawhub.ai`, `www.skills.sh`), `redirect: "error"`, timeouts, byte caps.
- `clawhub.ts` — `searchClawHub(q)`, `listClawHub({ sort, cursor })`, `getClawHubSkill(slug)` (detail incl. SKILL.md preview), `downloadClawHubSkill(slug, version?)` → ZIP via `GET /api/v1/download` extracted with `fflate`; handles GitHub-handoff responses (`sourceRef: "public-github"` → delegates to github.ts with `repo`/`commit`/`path`); passes `nonSuspiciousOnly=true` on search/list.
- `skillssh.ts` — `searchSkillsSh(q)` via public `GET /api/search?q=`; install resolves `source` (`owner/repo[/subpath]`) + `skillId` through github.ts.
- `github.ts` — `listRepoSkills(owner, repo, ref?)` via git trees API (finds every `*/SKILL.md`), `fetchSkillFromGithub(owner, repo, skillPath, ref?)` (downloads folder files via raw.githubusercontent.com), `fetchGithubJson`/`fetchGithubTarballFile` helpers reused by the plugin installer.

### Plugins core (`src/lib/plugins/`)
- `marketplace.ts` — `addMarketplace(source)` (fetches `.claude-plugin/marketplace.json` via github.ts for GitHub repos; validates manifest: `name`, `owner.name`, `plugins[]` with `name`+`source`), `removeMarketplace`, `listMarketplaces`, `getMarketplaceCatalog(id)` (re-fetch manifest, join with installed state).
- `installer.ts` — resolves a plugin entry source:
  - relative path → folder within the marketplace repo (trees API + raw fetch),
  - `github` `{repo, ref?}` → repo root or plugin subdir,
  - `git-subdir` `{url, path, ref?}` → github.com URLs via trees+raw; non-GitHub git URLs rejected with a clear error (no git binary dependency),
  - `url` git → same treatment when github.com,
  - `archive` `{url}` → HTTPS zip within allowlisted hosts, extracted with fflate,
  - `npm`/`command` → unsupported, surfaced in UI.
  Extraction writes to `data/plugins/<marketplace>/<plugin>/` with traversal guards; then `mapComponents` runs.
- `components.ts` — `mapComponents(pluginDir, pluginRow)`:
  - `skills/<name>/SKILL.md` (+ root `SKILL.md`) → installed into the skills store namespaced (`plugin-name:skill-name` display; stored name stays spec-valid via slug), `source.kind = "plugin"`, `pluginId` set.
  - `commands/*.md` → `plugin_commands` rows (frontmatter parsed for description/argument-hint).
  - `.mcp.json` / manifest `mcpServers` → converted to `McpServerConfig[]` and appended to the `mcpServers` settings registry **disabled**, tagged `metadata.pluginId` (stdio servers keep command/args/env; http/sse keep url/headers; invalid entries skipped and reported).
  - hooks/output-styles/themes/lsp/monitors → counted into `components.ignored`, never parsed for execution.
- `lifecycle.ts` — `enablePlugin`/`disablePlugin` (flips plugin row + its skills' `enabled`; commands excluded from chat when disabled; MCP servers are user-managed separately and are not auto-toggled), `uninstallPlugin` (removes dir, rows, plugin-tagged MCP registry entries still disabled-orphaned are removed).

### Chat integration
- `synthesizeSystemPrompt` (`src/lib/ai/prompt.ts`) gains a **skills catalog layer** (new budget `skillsTokens` ≈ 800) appended after the base layer, listing enabled skills (plugin skills included) — pure addition, existing layers untouched.
- `chatTools` (`src/lib/ai/tools.ts`) gains:
  - `use_skill({ name })` → returns SKILL.md body + bundled file list (progressive disclosure step 2); unknown name → error listing available skills.
  - `read_skill_file({ name, path })` → bounded file content (step 3); text files only, 200KB cap.
  - `list_installed_skills()` → catalog with enabled state (cheap discovery aid).
  - `create_skill({ name, description, content, files? })` / `update_skill({ name, ... })` / `delete_skill({ name })` — spec-validated writes to the store (`source.kind = "local"`), so the assistant can run the skill-creator workflow end-to-end.
- Plugin commands: exposed to the client via `/api/plugins/commands` (enabled plugins only); the prompt input offers `/<command>` completions and expands them into the message (content + `$ARGUMENTS` substitution) before send. The model is also told available command names in the skills catalog layer footer (one line).

### API surface
- `GET /api/skills` — installed skills (+ built-ins) with metadata.
- `POST /api/skills/install` — `{ registry: "clawhub", slug, version? } | { registry: "skillssh", id } | { registry: "github", owner, repo, path, ref? }`.
- `POST /api/skills` — manual create (wizard / tool parity): `{ name, description, content, files? }`.
- `PATCH /api/skills/[id]` — `{ enabled }` toggle.
- `DELETE /api/skills/[id]` — uninstall (plugin-owned skills rejected with "uninstall the plugin" error).
- `GET /api/skills/search?registry=clawhub|skillssh&q=&sort=&cursor=` — registry search/browse passthrough.
- `GET /api/skills/[id]/files?path=` — read bundled file (UI preview).
- `GET /api/plugins/marketplaces` / `POST /api/plugins/marketplaces` (`{ source }`) / `DELETE /api/plugins/marketplaces/[id]`.
- `GET /api/plugins/catalog?marketplace=` — manifest entries + installed/enabled state.
- `POST /api/plugins/install` — `{ marketplaceId, pluginName }`.
- `GET /api/plugins` — installed plugins with component summaries.
- `PATCH /api/plugins/[id]` — `{ enabled }`.
- `DELETE /api/plugins/[id]`.
- `GET /api/plugins/commands` — enabled commands for chat slash-expansion.

### UI
- **Skills page** (`src/components/skills-view.tsx`) — same layout contract as MCP/Settings views; opened from sidebar System menu. Sections: search bar with registry selector (ClawHub / skills.sh) + result cards (name, summary, installs/downloads, owner, security note for ClawHub verdicts) + Install button; "Install from GitHub…" dialog (`owner/repo` or URL → skill picker); installed list (enable switch, source badge, version, content viewer dialog with file tree, delete); "New skill" wizard dialog (name/description/content + optional files, live spec validation); banner linking to the skill-creator flow ("ask the assistant to create a skill").
- **Plugins page** (`src/components/plugins-view.tsx`) — marketplace manager (official pre-seeded, add-by-URL dialog, remove, last synced), catalog browser for the selected marketplace (category filter, search, install button, unsupported-source badge), installed plugins list (enable switch, component badges: n skills / n commands / n MCP / ignored list, uninstall).
- `page.tsx` view union gains `"skills" | "plugins"`; sidebar System menu gains both entries above MCP Servers.

### Dependencies
- `yaml` (frontmatter parsing; already in the pnpm store transitively, add as direct dep).
- `fflate` (zero-dep ZIP inflate for ClawHub/archive downloads).

## Security model
- **Host allowlist** for all outbound fetches (see registries/http.ts); every other host rejected. Redirects rejected (`redirect: "error"`), matching the MCP SSRF posture.
- **No execution**: plugin hooks are never parsed for execution; no `command` sources; skill scripts are stored as inert files (the assistant may read them, running them is out of scope — Yggdrasil has no shell tool).
- **Path traversal**: every file written from a registry/archive is validated (relative, no `..`, no absolute, no symlink entries, name length caps); ZIP/tar entries checked before extraction; total file count (≤100/skill, ≤500/plugin) and byte caps (≤2MB/file, ≤20MB/skill, ≤50MB/plugin).
- **Prompt injection**: third-party skills are model instructions — install UI shows a trust warning with source/owner; ClawHub search passes `nonSuspiciousOnly=true`; ClawHub moderation verdict shown on detail.
- **Input validation**: all API payloads shape-checked server-side (same discipline as MCP routes); skill names/descriptions validated per spec; marketplace manifests validated before persistence.
- Single-user self-hosted app: no auth layer added (consistent with existing routes).

## Testing (vitest; single sequential test runner per global rules)
- `src/lib/skills/__tests__/spec.test.ts` — frontmatter parsing, name/description validation matrix, path sanitization (traversal, absolute, symlink, caps).
- `src/lib/skills/__tests__/store.test.ts` — install/uninstall/toggle against a temp dir + in-memory-style temp sqlite; atomic writes; plugin cascade.
- `src/lib/skills/__tests__/registries.test.ts` — clawhub/skillssh/github clients against a mocked `fetch` (search shapes, zip extraction via fflate with a generated archive, GitHub handoff delegation, host allowlist, redirect rejection).
- `src/lib/plugins/__tests__/installer.test.ts` — marketplace manifest validation, source resolution matrix (relative/github/git-subdir/archive; npm/command → unsupported), component mapping (skills namespacing, commands parsing, MCP conversion disabled-by-default), traversal guards.
- `src/app/api/__tests__/skills-api.test.ts` + `plugins-api.test.ts` — route happy paths + rejection cases.
- Existing chat route/prompt tests extended for the skills catalog layer and new tools.

## Out of scope (future work)
- Anthropic/OpenAI provider-side skill uploads (`uploadSkill`) as an optional per-provider enhancement.
- Plugin `agents/*.md` as real subagents (no subagent runtime yet); `userConfig` prompts; plugin dependencies; plugin updates/version pinning UI (install is latest; re-install to update).
- skills.sh official `/api/v1` (needs Vercel OIDC) and its `audit` data; ClawHub publishing/login; skill update checks.
- Executing skill-bundled scripts; hook execution; non-GitHub git hosts for plugin sources (would need a git binary).
- Marketplace background auto-refresh (manual sync button only).
