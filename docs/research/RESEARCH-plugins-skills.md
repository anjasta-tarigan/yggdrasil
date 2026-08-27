# Research: Plugins & Skills Features for Yggdrasil

Date: 2026-08-28
Status: Complete — feeds `docs/superpowers/specs/2026-08-28-plugins-skills-design.md`

## 1. AI SDK v7 (installed: ai@7.0.77) — what it offers natively

Bundled docs at `node_modules/ai/docs/` were read (per the `ai-sdk` skill: never trust memory).

### 1.1 Harness Skills (`docs/03-ai-sdk-harnesses/04-skills.mdx`)
- `HarnessAgent` accepts a `skills: [{ name, description, content, files[] }]` setting.
- Harnesses run **external agent runtimes** (Claude Code, Codex, Pi) inside a sandbox via adapter packages (e.g. `@ai-sdk/harness-claude-code`). Marked **experimental**.
- Not a fit for Yggdrasil: we run our own `streamText` tool loop against arbitrary OpenAI-compatible providers, not a sandboxed Claude Code runtime.

### 1.2 Skill Uploads (`docs/03-ai-sdk-core/41-skill-uploads.mdx`)
- `uploadSkill({ api: anthropic.skills(), files: [...] })` → `ProviderReference` passed via `providerOptions.anthropic.container.skills`.
- Provider-side skills: only **Anthropic** (`container.skills`, requires code-execution container tool) and **OpenAI** (`shell` tool `environment.skills`).
- Not a fit as the primary mechanism: Yggdrasil is multi-provider (openai-compatible/Ollama); provider skills would only work on some models. Useful as an optional future enhancement for Anthropic-routed chats.

### 1.3 Conclusion
Yggdrasil should implement skills **harness-style, provider-agnostic**: progressive
disclosure through the system prompt + a `use_skill` tool (see §5). This is exactly how
Claude Code/Cursor/etc. do it for non-API skills and works with every provider we support.

## 2. Agent Skills open standard (agentskills.io)

Sources: [agentskills.io/specification](https://agentskills.io/specification), [github.com/agentskills/agentskills](https://github.com/agentskills/agentskills)

- A skill = **folder with `SKILL.md`** (YAML frontmatter + markdown instructions) plus optional bundled resources (scripts, references, templates).
- Required frontmatter:
  - `name` — ≤64 chars, `[a-z0-9-]`, no leading/trailing/consecutive hyphens, must match parent dir name.
  - `description` — ≤1024 chars, what + when.
- Optional: `license`, `compatibility` (≤500 chars env requirements), `metadata` (string→string map), `allowed-tools` (experimental).
- **Progressive disclosure** (the design pattern to replicate):
  1. Metadata (~100 tokens): name+description of *all* skills loaded at startup.
  2. Instructions (<5000 tokens recommended): SKILL.md body loaded **when activated**.
  3. Resources: bundled files read on demand.
- Claude Code superset fields (only meaningful inside Claude Code, must be tolerated/ignored by us): `disable-model-invocation`, `user-invocable`, `argument-hint`, `arguments`, `context: fork`, `model`, `effort`, `hooks`, `paths`, `shell`, `when_to_use`, `disallowed-tools`.
- Claude Code skill locations: `~/.claude/skills/`, `.claude/skills/`, plugin `skills/` dirs.

## 3. Claude Code Plugins & Marketplaces (the "Plugins Marketplace" model)

Sources: [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [plugins-reference](https://code.claude.com/docs/en/plugins-reference), [skills](https://code.claude.com/docs/en/skills) (fetched copies in this folder).

### 3.1 Marketplace format
A marketplace = git repo (or URL/npm/zip) containing `.claude-plugin/marketplace.json`:

```json
{
  "name": "claude-plugins-official",        // kebab-case, public-facing
  "description": "...",
  "owner": { "name": "Anthropic", "email": "...", "url": "..." },
  "plugins": [
    {
      "name": "my-plugin",                   // required
      "source": "./plugins/my-plugin",       // required — see source types
      "description": "...",
      "category": "development",
      "tags": ["..."], "version": "1.0.0",
      "author": { "name": "..." }
    }
  ]
}
```

Plugin `source` types: relative path (`"./..."` in same repo), `github` `{repo, ref?, sha?}`,
`url` (git URL), `git-subdir` `{url, path, ref?, sha?}`, `npm` `{package, version?}`,
`archive` `{url, sha256?}` (zip over HTTPS), `command` (local command — we will NOT support this; arbitrary code execution).

### 3.2 Plugin format
Plugin = directory with optional `.claude-plugin/plugin.json` manifest (`name` only required field) and components in default locations:

| Component | Location | Yggdrasil mapping |
|---|---|---|
| Skills | `skills/<name>/SKILL.md` (or root `SKILL.md`) | ✅ first-class: namespaced skill `plugin:skill` |
| Commands | `commands/*.md` (flat skill-style files) | ✅ chat slash-commands / prompt templates |
| Agents | `agents/*.md` | ⚠️ phase 2 (no subagent runtime yet) — surface as prompt templates |
| MCP servers | `.mcp.json` / `mcpServers` manifest field | ✅ merge into existing MCP registry (disabled by default) |
| Hooks | `hooks/hooks.json` | ❌ ignore (Claude Code lifecycle-specific; never execute) |
| Output styles / themes / LSP / monitors | various | ❌ ignore, show as "unsupported components" |

`plugin.json` also supports `userConfig` (prompted user settings), `dependencies`, `defaultEnabled`.

### 3.3 Official marketplaces (verified via GitHub API)
- [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official) — official Anthropic-managed plugin directory (default marketplace).
- [`anthropics/claude-code`](https://github.com/anthropics/claude-code) — bundled plugins (`agent-sdk-dev`, PR review, commit workflows).
- [`anthropics/knowledge-work-plugins`](https://github.com/anthropics/knowledge-work-plugins) — knowledge-worker plugins (docx/pptx/xlsx family).
- Any third-party marketplace can be added by git repo URL (user requirement: "and something else").

## 4. Skill registries

### 4.1 skills.sh (Vercel Labs)
Sources: [skills.sh](https://www.skills.sh/), [vercel-labs/skills](https://github.com/vercel-labs/skills), [API docs](https://www.skills.sh/docs/api)

- "npm for agent skills": `npx skills add <source>`, `npx skills find`, `npx skills use`.
- Sources are **GitHub repos** (`owner/repo`, full URLs, direct paths, GitLab, local paths). Install = copy the skill folder into the target agent's skills dir.
- **Official API** (`/api/v1/skills`, `/search`, `/curated`, `/audit`) **requires Vercel OIDC auth** — unusable from a self-hosted app (verified: 401 without token).
- **Public web endpoint found (verified live, no auth):**
  - `GET https://www.skills.sh/api/search?q=<query>` → `{ query, searchType, skills: [{ id: "owner/repo/skillId", skillId, name, installs, source: "owner/repo" }] }`
- Install path therefore resolves through **GitHub** (same as the CLI):
  - `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1` → locate `<dir>/SKILL.md` whose dir name matches `skillId` (verified live).
  - Fetch files from `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` (no API rate limit; only the trees call costs 1 of 60 unauthenticated API req/h).
- Top sources in the catalog: `anthropics/skills`, `vercel-labs/skills`, `openai/skills`, `github/awesome-copilot`.

### 4.2 ClawHub (OpenClaw)
Sources: [docs.openclaw.ai/clawhub](https://docs.openclaw.ai/clawhub), [openclaw/clawhub](https://github.com/openclaw/clawhub), HTTP API doc (fetched copy in this folder)

- Public skill + plugin registry at [clawhub.ai](https://clawhub.ai); versioned `SKILL.md` bundles with semver, changelogs, downloads, security scans.
- **Public no-auth HTTP API (all verified live):**
  - `GET /api/v1/search?q=&limit=&nonSuspiciousOnly=true` → relevance-ranked results `{slug, displayName, summary, downloads, ownerHandle, ...}`
  - `GET /api/v1/skills?sort=downloads|trending|updated&limit=&cursor=` → browse/list
  - `GET /api/v1/skills/{slug}` → detail **incl. full SKILL.md text** in `skill.description`
  - `GET /api/v1/skills/{slug}/versions` → version list
  - `GET /api/v1/download?slug=&tag=latest` → **ZIP of the skill** (200 `application/zip` verified) — or 409/JSON GitHub handoff (`sourceRef: "public-github"`, `repo`, `commit`, `path`, `archiveUrl`) for GitHub-backed skills → follow up with GitHub fetch.
  - `GET /api/v1/skills/{slug}/file?path=&preview=1` → single file preview.
- Security: moderation verdicts (`clean`/`suspicious`/blocked) exposed per skill; pass `nonSuspiciousOnly=true` in search/list.
- Needs a ZIP extractor — none in current deps; propose `fflate` (zero-dep, MIT).

### 4.3 Direct GitHub install ("etc.")
- Any `owner/repo` or URL: list `SKILL.md` files via trees API, let user pick, download via raw. Covers `anthropics/skills`, `openai/skills`, and arbitrary repos.

## 5. Skill Creator (Anthropic official)

Source: [anthropics/skills/skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator) (SKILL.md fetched, ~33KB)

- Official skill that guides the full skill-development lifecycle: **capture intent → interview/research → draft SKILL.md → test cases → eval/iterate → description optimizer**.
- Key authoring guidance to encode:
  - `description` is the primary trigger — must include what it does AND when to use it; make it assertive ("use this skill whenever…") to combat under-triggering.
  - Keep body concise; move bulky reference material to bundled files (`references/…`, `scripts/…`) referenced by relative path.
  - Frontmatter limited to the 6 spec fields for portability.
- Integration plan for Yggdrasil:
  1. Bundle `skill-creator` itself as a built-in skill (auto-installed seed).
  2. Add server tools `create_skill` / `update_skill` / `delete_skill` / `list_installed_skills` so the assistant can actually write skills to the skills store mid-conversation (the "skill creator" workflow).
  3. Optional manual "New skill" wizard in the Skills UI (name/description/content validation per spec).

## 6. Proposed Yggdrasil integration (summary — details in the design spec)

- **Storage**: skills/plugins on disk under `data/skills/<name>/` and `data/plugins/<marketplace>/<plugin>/`; registry metadata (source, version, enabled, provenance) in SQLite (drizzle) tables.
- **Runtime**: progressive disclosure — skill catalog (name+description, token-budgeted) appended to the synthesized system prompt; new tools `use_skill` (returns SKILL.md body + file list) and `read_skill_file` (bounded file read). Provider-agnostic, mirrors agentskills.io loading model.
- **Plugins view**: marketplace manager (official Anthropic marketplace pre-seeded; add by GitHub repo/git URL) → browse catalog → install (fetch marketplace repo via GitHub tarball/trees; resolve plugin source; extract; map components: skills ✅, commands ✅, MCP servers ✅ disabled-by-default, hooks ❌ ignored) → enable/disable per plugin.
- **Skills view**: installed list (enable/disable/delete/view), install from **skills.sh** (public search API + GitHub resolution), **ClawHub** (public API + ZIP download), **GitHub URL/repo**, or **create** (wizard + AI skill-creator flow).
- **Security**: HTTPS allowlist of hosts (github.com, api.github.com, raw.githubusercontent.com, codeload.github.com, clawhub.ai, skills.sh); reject redirects; path-traversal guards on extraction; file count/size caps; trust warning before install (third-party instructions = prompt-injection surface); never execute plugin hooks/commands.

## Key source links
- [Agent Skills specification](https://agentskills.io/specification) · [agentskills/agentskills](https://github.com/agentskills/agentskills)
- [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) · [plugins reference](https://code.claude.com/docs/en/plugins-reference) · [skills](https://code.claude.com/docs/en/skills)
- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) · [anthropics/skills](https://github.com/anthropics/skills) · [skill-creator](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
- [skills.sh](https://www.skills.sh/) · [skills.sh API](https://www.skills.sh/docs/api) · [vercel-labs/skills CLI](https://github.com/vercel-labs/skills)
- [ClawHub](https://clawhub.ai) · [ClawHub docs](https://docs.openclaw.ai/clawhub) · [openclaw/clawhub](https://github.com/openclaw/clawhub)
- AI SDK v7 bundled docs: `node_modules/ai/docs/03-ai-sdk-harnesses/04-skills.mdx`, `node_modules/ai/docs/03-ai-sdk-core/41-skill-uploads.mdx`
