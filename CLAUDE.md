# Yggdrasil — Project CLAUDE.md

@AGENTS.md
Always follow the rules described in `/home/anjasta/.claude/CLAUDE.md`

## Branch & release workflow

`main` is production; `development` is the integration branch. Branch off
`development` for every change and merge back into it. Cut releases with
`pnpm release <patch|minor|major|x.y.z>` from `development` — it merges into
`main`, pushes a `vX.Y.Z` tag, and GitHub Actions publishes the installer assets.
See `CONTRIBUTING.md` for the full workflow.

## Release process

Every release must include **release notes** that summarize the changes
included in that version. After tagging, populate the GitHub Release body
with a curated summary of user-visible changes from `CHANGELOG.md`:

```bash
# After `pnpm release` creates the tag, push release notes:
gh release edit v$(node -p "require('./package.json').version") \
  --notes "$(node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('CHANGELOG.md','utf8').split('\n');
    const v = process.argv[1];
    let start = lines.findIndex(l => l.startsWith('## ['+v+']'));
    let end = lines.findIndex((l,i) => i>start && l.startsWith('## ['));
    process.stdout.write(lines.slice(start, end>0?end:lines.length).join('\n').trim());
  " "$(node -p "require('./package.json').version")")"
```

### Release notes format

Group changes under these headings, drawn from the `CHANGELOG.md` entries
for that version:

- **Added** — New features and capabilities.
- **Changed** — Breaking changes and behavioral modifications.
- **Fixed** — Bug fixes and regressions.
- **Security** — Security-related fixes and hardening.

Use concise, user-facing language. Omit internal refactoring or build-only
changes unless they affect users.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `anjasta-tarigan/yggdrasil`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Project conventions

- **Tests:** Run `npx vitest run` before committing. Add tests for any behavior
  change. Prefer isolated, deterministic tests over integration tests.
- **Type checking:** Run `npx tsc --noEmit` before releasing.
- **Linting:** Run `npx eslint .` before committing.
- **Commits:** Follow Conventional Commits. Keep commits atomic and reviewable.
- **Changelog:** Update `CHANGELOG.md` under the `[Unreleased]` section for every
  user-visible change, following [Keep a Changelog](https://keepachangelog.com/)
  structure.
- **Secrets:** Never log secrets or store them in plaintext outside the
  secrets store. API keys and OAuth tokens are stored with the
  `mcp_${config.id}_*` prefix scheme in `@/lib/ai/mcp/secrets`.
