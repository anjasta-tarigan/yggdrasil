# Contributing & Release Workflow

Yggdrasil uses a two-branch model: `main` is the production release branch, and
`development` is the integration branch. Every change lands through a short-lived
feature branch off `development`, and a release promotes `development` into `main`
with a version tag.

```
feat/*  ──┐
fix/*   ──┼──> development ──> main ──> tag vX.Y.Z ──> GitHub Release
chore/* ──┘
```

## Branch Roles

| Branch | Purpose | Rules |
| :--- | :--- | :--- |
| `main` | Production. What `install.sh`/`install.ps1` and `yggdrasil update` track. | Only receives fast-forward merges from `development`. Never commit here directly. |
| `development` | Integration. The default working branch. | All feature work is merged here first. Must stay green (`pnpm test`). |
| `feat/*`, `fix/*`, `chore/*`, `docs/*` | One focused change each. | Branch off `development`, merge back into `development`, then delete. |

Branch naming follows the global git rules: `feat/`, `fix/`, `refactor/`, `exp/`,
`chore/`, `docs/`.

## Day-to-Day Development

```bash
git checkout development
git pull origin development
git checkout -b feat/voice-input

# ... implement, then verify locally ...
pnpm exec tsc --noEmit
pnpm exec eslint
pnpm test

# merge back into development
git checkout development
git merge --no-ff feat/voice-input
git push origin development
git branch -d feat/voice-input
```

Open a pull request against `development` when you want review before merging.

## Cutting a Release

Releases are a single command run from `development`. The script bumps
`package.json`, merges `development` into `main`, and pushes a `vX.Y.Z` tag.

```bash
git checkout development
git pull origin development

pnpm release patch   # 0.1.0 -> 0.1.1
pnpm release minor   # 0.1.0 -> 0.2.0
pnpm release major   # 0.1.0 -> 1.0.0
pnpm release 2.3.1   # explicit version
```

The script refuses to run when the tree is dirty, when you are not on
`development`, when local `development` is behind `origin`, or when the target
tag already exists.

Pushing the tag triggers `.github/workflows/release.yml`, which:

1. Checks out the tagged commit and installs dependencies.
2. Runs `tsc --noEmit`, `eslint`, and the unit suite as a release gate, plus a
   POSIX + PowerShell syntax check of both installer scripts.
3. Regenerates `install.sh.sha256` and `install.ps1.sha256` from the tagged
   scripts.
4. Publishes a GitHub Release with those four files as assets and generated
   release notes.

Every merge into `development` is additionally gated by `.github/workflows/ci.yml`
(type-check, lint, tests, installer syntax), so a broken installer cannot reach
`main`; and `.github/workflows/publish-installer.yml` re-publishes the four
installer assets to the latest release on every **merge into `main`** (skipping
the release merge itself), so the checksum-verified install URLs always serve the
freshest merged `main` code.

No manual checksum step is required — the workflow owns the `.sha256` companions,
so the published installers always match the published hashes.

## What Users Get

- New installs: `curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash`
- Existing installs: `yggdrasil update` fast-forwards the app directory to the
  latest `main`, rebuilding with an automatic SQLite WAL backup and rollback on
  failure.
- Update discovery: `yggdrasil check-update` checks whether a newer GitHub
  release is available; Settings -> About shows an actionable badge.

> **New installs track `main`, not a frozen tag.** The installers resolve the
> latest release *only* to verify the installer script against its published
> SHA-256, then check out `main` (the latest merged `development`) unless
> `YGGDRASIL_VERSION` is explicitly pinned. Merged fixes therefore reach new
> installs immediately, instead of waiting for the next tagged release.

## Key Workflows

| Workflow | Trigger | Purpose |
| :--- | :--- | :--- |
| `ci.yml` | PR/push to `development` | Merge gate: type-check, lint, tests, installer syntax. |
| `release.yml` | push of `v*` tag | Release gate + publish installer assets to the new release. |
| `publish-installer.yml` | push to `main` | Refresh installer assets on the latest release after every merge. |
- Existing installs: `yggdrasil update` fast-forwards the app directory to the
  latest `main`, rebuilding with an automatic SQLite WAL backup and rollback on
  failure.
- Update discovery: `yggdrasil check-update` checks whether a newer GitHub
  release is available; Settings -> About shows an actionable badge.

## Versioning

[Semantic Versioning](https://semver.org/):

- `patch` — bug fixes, no API or schema change.
- `minor` — backwards-compatible features (new tools, providers, UI).
- `major` — breaking changes to configuration, data layout, or public APIs.
