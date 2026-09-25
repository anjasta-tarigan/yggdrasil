@AGENTS.md
Always follow the rules describe on `/home/anjasta/.claude/CLAUDE.md`

## Branch & release workflow

`main` is production; `development` is the integration branch. Branch off
`development` for every change and merge back into it. Cut releases with
`pnpm release <patch|minor|major|x.y.z>` from `development` — it merges into
`main`, pushes a `vX.Y.Z` tag, and GitHub Actions publishes the installer assets.
See `CONTRIBUTING.md` for the full workflow.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `anjasta-tarigan/yggdrasil`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
