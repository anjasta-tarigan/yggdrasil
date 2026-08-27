# Plugins & Skills Feature — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-28-plugins-skills-design.md`
Research: `docs/research/RESEARCH-plugins-skills.md`

## Phases

### Phase 1 — Skills foundation (store + spec + runtime)
1. `pnpm add yaml fflate` (+ `@types` if needed).
2. `src/db/schema.ts`: add `skills`, `plugin_marketplaces`, `plugins`, `plugin_commands` tables; `src/db/init.ts`: idempotent CREATE TABLE blocks.
3. `src/lib/skills/spec.ts` — frontmatter parse/validate, name rules, file-path sanitization. + tests.
4. `src/lib/skills/store.ts` — disk+DB CRUD under `data/skills/`. + tests.
5. `src/lib/skills/catalog.ts` — prompt catalog builder + `use_skill`/`read_skill_file`/`list_installed_skills`/`create_skill`/`update_skill`/`delete_skill` tool factories.
6. Chat integration: skills layer in `synthesizeSystemPrompt` (new `skillsTokens` budget), tools merged in `chatTools`. Extend prompt/tools tests.

### Phase 2 — Registries (install sources)
7. `src/lib/skills/registries/http.ts` — guarded fetch (allowlist, no redirects, caps).
8. `src/lib/skills/registries/github.ts` — trees listing + raw fetch helpers.
9. `src/lib/skills/registries/clawhub.ts` — search/list/detail/download-zip (+ handoff). 
10. `src/lib/skills/registries/skillssh.ts` — public search + GitHub resolution.
11. Tests with mocked fetch + generated zip fixtures.

### Phase 3 — Plugins
12. `src/lib/plugins/marketplace.ts` — add/remove/list/sync marketplaces; manifest validation; seed official Anthropic marketplace row on first boot.
13. `src/lib/plugins/installer.ts` — source resolution + guarded extraction to `data/plugins/`.
14. `src/lib/plugins/components.ts` — map skills/commands/MCP (disabled) into Yggdrasil stores.
15. `src/lib/plugins/lifecycle.ts` — enable/disable/uninstall cascades. + installer tests.

### Phase 4 — API routes
16. `/api/skills*` routes (list, search passthrough, install, create, toggle, delete, file read).
17. `/api/plugins*` routes (marketplaces CRUD, catalog, install, list, toggle, uninstall, commands).
18. Route tests.

### Phase 5 — UI
19. `skills-view.tsx` (search/install/create/manage) + `plugins-view.tsx` (marketplaces/catalog/installed).
20. Sidebar entries + `page.tsx` view wiring; slash-command expansion for plugin commands in the prompt input.
21. Built-in `skill-creator` seed (`src/lib/skills/builtin.ts`, best-effort on boot + manual retry in UI).

### Phase 6 — Verification
22. `pnpm lint`, `tsc --noEmit` via `pnpm build` or typecheck, full `pnpm test` (single sequential run), manual smoke via running dev server.

## Conventions
- Follow existing module style (see `src/lib/ai/mcp/`): pure shared config modules, server managers, sanitized API routes, in-shell views with the MCP/Settings layout contract.
- Tests colocated in `__tests__` dirs; vitest single-runner rule; no empty catches; bounded inputs at every boundary.
- No commits to main by the agent (Git invariant) — leave changes in the working tree for review.
