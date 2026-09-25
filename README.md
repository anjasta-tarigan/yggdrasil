# Yggdrasil

[![Release](https://img.shields.io/github/v/release/anjasta-tarigan/yggdrasil)](https://github.com/anjasta-tarigan/yggdrasil/releases/latest)

Personal, self-hosted AI assistant designed for privacy, local execution, and extensible agentic workflows. Built on Next.js, React 19, and the AI SDK with native SQLite vector storage and background daemon management.

---

## Key Features

- **Multi-Provider Architecture:**
  - **Ollama:** Full support for locally served models.
  - **OpenAI-Compatible:** Connect to vLLM, LM Studio, LocalAI, or cloud endpoints.
  - **NVIDIA NIM:** Enterprise accelerated inference endpoints.
  - **DeepSeek Web (Experimental):** Direct web-session adapter featuring cryptographic Proof-of-Work (Keccak-p[1600, 23]) solving, two-phase authentication, SSE patch-streaming, and AES-256-GCM encrypted credential storage.
- **Local Neural Search & Embeddings:**
  - Embedded vector search via `sqlite-vec` with SQLite Write-Ahead Logging (WAL) and FTS5 full-text search.
  - Neural reranking powered by `bge-reranker-v2-m3` ONNX INT8 with automatic idle memory eviction and reciprocal rank fusion (RRF) fallback.
  - On-device embedding inference using `onnxruntime-node`.
- **Project Workspaces & Agentic Chat:**
  - Workspace management with project directories, multi-session chat feeds, custom instructions, and trust levels.
  - Integrated collapsible project file explorer and file inspection.
  - Multi-agent orchestration and background subagent runners with sandboxed tool delegation.
  - Streaming reasoning traces (Chain-of-Thought / `THINK` segments) and structured artifact viewing.
- **Built-in Tools:**
  - `web_search` & `web_fetch`: Real-time web retrieval with link scraping.
  - `image_search`: Multi-backend web image search (Exa, SearXNG, Firecrawl) with SSRF defense, private IP blocking, and responsive lightbox galleries.
  - `bash` (with `shell`/`exec` aliases) and the `readFile`/`writeFile` file tools, sandboxed with explicit user permissions and toggleable in Settings.
- **Self-Hosting & Lifecycle Daemon:**
  - Native background service management (`systemd --user` on Linux, `launchd` on macOS, Task Scheduler on Windows).
  - Recoverable update pipeline: stops the service, backs up the SQLite database with its WAL/SHM companions, and rolls back to the previous commit and database on any failure.

---

## Architecture Overview

**Source repository:**

```
yggdrasil/
├── bin/yggdrasil.mjs        # CLI launcher (loads tsx, runs src/cli)
├── scripts/release.mjs      # One-command release: bump, merge to main, tag
├── .github/workflows/       # Release CI (typecheck, tests, checksums, publish)
└── src/
    ├── app/                 # Next.js App Router (pages, API routes, streaming)
    ├── cli/                 # Cross-platform installer & service daemon CLI
    ├── components/          # React 19 UI (shadcn/ui + Tailwind CSS v4)
    ├── db/                  # Drizzle schema, migrations, SQLite vector init
    ├── lib/                 # AI SDK integration, providers, tools, security
    └── workflows/           # Workflow DevKit durable harness steps
```

**Installed layout** (`~/.yggdrasil`, created by the installer):

```
~/.yggdrasil/
├── app/                     # Git checkout; `pnpm start` runs here
│   ├── .env -> ../.env      # Linked so Next.js loads APP_SECRET at runtime
│   └── data -> ../data      # Linked so the app reads canonical state
├── data/                    # Canonical persistent state (survives updates)
│   ├── yggdrasil.db         # SQLite (sessions, messages, vector embeddings)
│   ├── providers.json       # Provider config (atomic file-lock protected)
│   ├── providers.secrets.env # API keys (mode 0600)
│   ├── models/              # ONNX models (embeddings, reranker)
│   ├── backups/             # Timestamped DB snapshots from `yggdrasil update`
│   └── logs/                # Daemon stdout/stderr
└── .env                     # PORT, NODE_ENV, APP_SECRET (mode 0600)
```

---

## Quick Start & CLI Installation

### Prerequisites

| Requirement | Minimum | Notes |
| :--- | :--- | :--- |
| Node.js | **22.13.0** | pnpm 11.x loads the `node:sqlite` builtin, which landed in Node 22.5 and stabilized in 22.13. The installers reject older runtimes up front. |
| pnpm | 11.x | Installed automatically via `corepack` or `npm install -g pnpm` if missing. |
| Git | any | Used to clone and to update the app directory. |

### One-Line Installers

#### Linux & macOS (POSIX)
```bash
curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash
```

#### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.ps1 | iex
```

#### What the bootstrap does

1. **Resolves the latest release tag** from the GitHub API (override with `YGGDRASIL_VERSION=<tag>`). Set `YGGDRASIL_CHANNEL=main` to install straight from the `main` branch instead.
2. **Verifies before executing.** The script you fetch acts as a trampoline: it re-downloads the installer from the pinned release asset, checks that copy against its published SHA-256, and runs only the verified copy. A tampered payload served in transit is rejected. All downloads are pinned to HTTPS — plain HTTP and redirects that downgrade away from HTTPS are refused.
3. **Checks prerequisites**, then checks out the verified release tag (or `main` on the `YGGDRASIL_CHANNEL=main` path) with `--depth 1`.
4. **Installs dependencies and builds** the production Next.js bundle (with a 2 GiB V8 heap ceiling so small VPS instances do not get OOM-killed).
5. **Registers a background service** — `systemd --user` on Linux, `launchd` on macOS, Task Scheduler on Windows — and polls `/api/health` until the app answers.

The installer generates `~/.yggdrasil/.env` with a random 32-byte `APP_SECRET` (mode `0600`) on first install and links it into the app root so Next.js reads it at runtime on every platform.

A release install pins the code to the verified tag, so the running build matches the verified script. `yggdrasil update` then moves the install onto `main` and tracks it from there.

#### Installer options

Both scripts accept environment variables:

| Variable | Effect |
| :--- | :--- |
| `YGGDRASIL_VERSION=<tag>` | Install a specific release, e.g. `v0.1.1`. |
| `YGGDRASIL_CHANNEL=main` | Skip the release gate and install from the `main` branch (for development). |
| `GITHUB_TOKEN` / `GH_TOKEN` | Optional; raises the GitHub API rate limit when resolving the latest release. |

```bash
# Pin a specific release
YGGDRASIL_VERSION=v0.1.1 curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash

# Track main instead of a release (development installs)
YGGDRASIL_CHANNEL=main curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash
```

#### Running the script locally

`install.sh` and `install.ps1` live at the repository root, so you can also run them from a checkout. A positional argument overrides the install directory:

```bash
./install.sh                    # installs to ~/.yggdrasil
./install.sh /opt/yggdrasil     # installs to a custom directory
```

```powershell
.\install.ps1                   # installs to %USERPROFILE%\.yggdrasil
.\install.ps1 -TargetDir D:\yggdrasil
```

The script is idempotent: re-running it against an existing install updates the checkout, rebuilds, and re-registers the service.

---

### Manual Installation & Development

```bash
# 1. Clone repository
git clone https://github.com/anjasta-tarigan/yggdrasil.git
cd yggdrasil

# 2. Install dependencies (Node >= 22.13.0)
pnpm install

# 3. Configure environment
cp .env.example .env.local
# Set APP_SECRET (min 32 characters) for data-at-rest encryption
# Optionally configure EXA_API_KEY, FIRECRAWL_API_KEY, or SEARXNG_BASE_URL

# 4. Start development server
pnpm dev

# 5. Verify before committing
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint
```

---

## Service Management CLI

Once installed, the `yggdrasil` executable is linked to `~/.local/bin` (Linux/macOS) or `%USERPROFILE%\.yggdrasil\bin` (Windows):

| Command | Description |
| :--- | :--- |
| `yggdrasil status` | Check background service status and active HTTP port (default: `2302`) |
| `yggdrasil start` | Start the background service daemon |
| `yggdrasil stop` | Stop the running service daemon |
| `yggdrasil restart` | Restart the background service |
| `yggdrasil logs` | Tail system stdout and stderr log files |
| `yggdrasil update` | Pull latest `main`, back up the database, rebuild, and roll back on failure |
| `yggdrasil uninstall` | Remove OS service and application files (use `--purge` to delete database & state) |

---

## Updating an Installation

Existing installs update in place with a single command:

```bash
yggdrasil update
```

The update pipeline is designed to be recoverable:

1. Refuses to run if the app directory has uncommitted local changes.
2. Stops the background service so no SQLite writer is active.
3. Backs up `yggdrasil.db` plus its `-wal`/`-shm` companions to `data/backups/backup-<timestamp>/`.
4. Fast-forwards the app directory to the latest `main`, reinstalls dependencies, and rebuilds.
5. On any failure, hard-resets git to the previous commit, restores the database backup, and restarts the old build.

---

## Development & Releases

`main` is the production branch that the installers and `yggdrasil update`
track. `development` is the integration branch where work lands first. The two
are kept identical between releases.

```bash
git checkout development
git pull origin development
git checkout -b feat/my-feature   # branch off development
# ... implement and verify ...
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint
git checkout development && git merge --no-ff feat/my-feature
git push origin development
```

Cut a release with one command from `development`:

```bash
pnpm release patch   # 0.1.0 -> 0.1.1
pnpm release minor   # 0.1.0 -> 0.2.0
pnpm release major   # 0.1.0 -> 1.0.0
pnpm release 2.3.1   # explicit version
```

The script refuses to run on a dirty tree, from the wrong branch, when local
`development` is behind `origin`, or when the target tag already exists. It then
bumps `package.json`, merges `development` into `main`, and pushes the `vX.Y.Z`
tag.

Pushing the tag triggers `.github/workflows/release.yml`, which generates the
Next.js route types, type-checks, runs the unit suite, regenerates the installer
SHA-256 checksums from the tagged scripts, and publishes the GitHub Release with
`install.sh`, `install.ps1`, and both `.sha256` companions. Because CI owns the
checksums, the published hashes always match the published installers.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

---

## Configuration & Environment Variables

Environment settings can be declared in `.env.local`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `2302` | HTTP server port |
| `NODE_ENV` | `production` | Runtime mode; set by the installer's `.env`. |
| `APP_SECRET` | Required in prod | 32+ character secret for AES-256-GCM data encryption. Generated automatically by the installer. |
| `DATABASE_PATH` | `data/yggdrasil.db` | Custom location for the SQLite database file |
| `YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS` | `false` | Enable experimental web session providers (DeepSeek Web) |
| `RERANKER_ENABLED` | `true` | Enable ONNX neural cross-encoder reranking |
| `EXA_API_KEY` | None | API key for Exa search and image search |
| `FIRECRAWL_API_KEY` | None | API key for Firecrawl web search and scrape |
| `SEARXNG_BASE_URL` | None | Self-hosted SearXNG endpoint for search and images |

Installer-only variables (read by `install.sh` / `install.ps1`, not by the app):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `YGGDRASIL_VERSION` | latest release | Pin installation to a specific release tag. |
| `YGGDRASIL_CHANNEL` | unset | Set to `main` to install from the `main` branch instead of a release. |
| `GITHUB_TOKEN` / `GH_TOKEN` | unset | Optional; raises the GitHub API rate limit when resolving the latest release. |

---

## Security Invariants

- **Isolated Development:** In the source repository, caches, databases, and logs are bound to project-local paths (`.cache/`, `data/`, `tmp/`). Nothing is written to `$HOME` while developing or testing. The *installed* app is the deliberate exception: it lives entirely under `~/.yggdrasil`, which the installer owns.
- **Encrypted Credentials:** Session tokens and credentials are encrypted using AES-256-GCM with keys derived via HKDF from `APP_SECRET`.
- **Verified Distribution:** The bootstrap installers verify their own SHA-256 against the published release asset before running, and pin all downloads to HTTPS (plain HTTP and protocol-downgrading redirects are refused). CI regenerates the checksums from the tagged scripts, so published hashes always match published installers.
- **SSRF & Network Defense:** Outbound image fetchers, link scrapers, and web hooks enforce URL protocol validation and reject loopback, RFC 1918 private subnets, and cloud metadata addresses (`169.254.169.254`).
- **CSRF & Rate Limiting:** All mutation routes enforce strict Origin/Referer header checks and sliding-window rate limiters.
- **Secrets at Rest:** `.env` (holding `APP_SECRET`) and `providers.secrets.env` are written with owner-only permissions (`0600`) and are git-ignored.

