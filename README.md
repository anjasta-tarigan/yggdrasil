# Yggdrasil

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
  - Sandboxed file tools (`read_file`, `write_file`, `edit_file`) with explicit user permissions and toggleable settings.
- **Self-Hosting & Lifecycle Daemon:**
  - Native background service management (`systemd --user` on Linux, `launchd` on macOS, Task Scheduler on Windows).
  - Atomic update pipeline with automated SQLite WAL checkpointing, full backup, and rollback on build failure.

---

## Architecture Overview

```
yggdrasil/
├── app/                  # Next.js App Router (UI, API Routes, Streaming)
├── bin/                  # CLI launcher (bin/yggdrasil.mjs)
├── data/                 # Canonical persistent user state (survives updates)
│   ├── yggdrasil.db      # SQLite database (sessions, messages, vector embeddings)
│   ├── providers.json    # Provider configurations (atomic file-lock protected)
│   ├── models/           # ONNX models (embeddings, reranker)
│   ├── skills/           # Custom agent skills
│   └── logs/             # System daemon stdout/stderr
└── src/
    ├── cli/              # Cross-platform installer & service daemon CLI
    ├── components/       # React 19 UI components (shadcn/ui + Tailwind CSS v4)
    ├── db/               # Drizzle ORM schema, migrations, and SQLite vector init
    └── lib/              # AI SDK integration, web providers, tools, security guards
```

---

## Quick Start & CLI Installation

### One-Line Installers

#### Linux & macOS (POSIX)
```bash
curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash
```

#### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.ps1 | iex
```

The bootstrap installers cryptographically verify script integrity via SHA-256, verify prerequisites (Node.js >= 22.13.0, Git, pnpm), clone the repository with shallow depth (`--depth 1`), build Next.js, and register a background user service.

---

### Manual Installation & Development

```bash
# 1. Clone repository
git clone https://github.com/anjasta-tarigan/yggdrasil.git
cd yggdrasil

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env.local
# Set APP_SECRET (min 32 characters) for data-at-rest encryption
# Optionally configure EXA_API_KEY, FIRECRAWL_API_KEY, or SEARXNG_BASE_URL

# 4. Start development server
pnpm dev

# 5. Run tests & verification
pnpm test
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
| `yggdrasil update` | Atomically pull latest code, backup SQLite WAL, rebuild, and rollback if failed |
| `yggdrasil uninstall` | Remove OS service and application files (use `--purge` to delete database & state) |

---

## Development & Releases

`main` is the production branch that the installers and `yggdrasil update`
track. `development` is the integration branch where work lands first.

```bash
git checkout development
git pull origin development
git checkout -b feat/my-feature   # branch off development
# ... implement and verify ...
pnpm test && pnpm exec tsc --noEmit && pnpm exec eslint
git checkout development && git merge --no-ff feat/my-feature
```

Cut a release with one command from `development`:

```bash
pnpm release patch   # 0.1.0 -> 0.1.1
pnpm release minor   # 0.1.0 -> 0.2.0
pnpm release major   # 0.1.0 -> 1.0.0
```

This bumps `package.json`, merges `development` into `main`, and pushes a
`vX.Y.Z` tag. GitHub Actions then type-checks, regenerates the installer
SHA-256 checksums, and publishes the GitHub Release assets automatically. See
[CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## Configuration & Environment Variables

Environment settings can be declared in `.env.local`:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `2302` | HTTP server port |
| `APP_SECRET` | Required in prod | 32+ character hex string for AES-256-GCM data encryption |
| `DATABASE_PATH` | `data/yggdrasil.db` | Custom location for the SQLite database file |
| `YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS` | `false` | Enable experimental web session providers (DeepSeek Web) |
| `RERANKER_ENABLED` | `true` | Enable ONNX neural cross-encoder reranking |
| `EXA_API_KEY` | None | API key for Exa search and image search |
| `FIRECRAWL_API_KEY` | None | API key for Firecrawl web search and scrape |
| `SEARXNG_BASE_URL` | None | Self-hosted SearXNG endpoint for search and images |

---

## Security Invariants

- **Isolated Storage:** All mutable databases and runtime logs reside strictly within the project directory or configured canonical target. No leakage to `$HOME`.
- **Encrypted Credentials:** Session tokens and credentials are encrypted using AES-256-GCM with keys derived via HKDF from `APP_SECRET`.
- **SSRF & Network Defense:** Outbound image fetchers, link scrapers, and web hooks enforce URL protocol validation and reject loopback, RFC 1918 private subnets, and cloud metadata addresses (`169.254.169.254`).
- **CSRF & Rate Limiting:** All mutation routes enforce strict Origin/Referer header checks and sliding-window rate limiters.

