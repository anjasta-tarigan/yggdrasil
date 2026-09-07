# Architecture & Design Specification: Yggdrasil System CLI Installer

**Date:** 2026-09-07  
**Status:** Approved for Implementation  
**Target Environments:** Linux (`systemd --user`), macOS (`launchd`), Windows (`schtasks`)  
**Default Production Port:** `2302`  
**Target Installation Path:** `~/.yggdrasil`

---

## 1. Executive Summary & Purpose

The Yggdrasil CLI installer provides a cross-platform, automated lifecycle management tool for self-hosting Yggdrasil. It enables zero-config installation, stable background execution, safe updates, and clean uninstallation while strictly safeguarding persistent state (databases, provider credentials, custom skills, and plugins).

Distribution is handled via curl/PowerShell bootstrap scripts that hand off to a unified Node.js/TypeScript CLI runner (`yggdrasil`), packaged directly with the repository.

---

## 2. System Architecture & Directory Layout

### 2.1 File System Structure

```
~/.yggdrasil/
├── app/                      # Git clone of Yggdrasil
│   ├── .next/                # Production Next.js build
│   ├── bin/
│   │   └── yggdrasil.mjs     # Primary CLI runner executable
│   ├── package.json
│   └── pnpm-lock.yaml
├── data/                     # Persistent state (preserved across updates)
│   ├── yggdrasil.db          # SQLite primary database (with -wal, -shm)
│   ├── providers.secrets.env # API keys & encrypted provider credentials
│   ├── logs/                 # System logs and daemon stdout/stderr
│   │   ├── yggdrasil.log
│   │   └── yggdrasil.err.log
│   ├── skills/               # Custom user skills
│   └── plugins/              # Active installed plugins
├── bin/                      # Windows command wrappers
│   ├── yggdrasil.cmd
│   └── start-background.ps1
├── .env                      # Production runtime env (PORT=2302, NODE_ENV=production)
├── yggdrasil.pid             # Running process ID (for process tracking & fallback)
└── version.json              # Version metadata, install date, and git commit SHA
```

### 2.2 Executable Placement & PATH Integration

- **Linux & macOS:**
  - Symlink created: `~/.local/bin/yggdrasil` -> `~/.yggdrasil/app/bin/yggdrasil.mjs`.
  - Installer ensures `~/.local/bin` is in PATH in `~/.bashrc`, `~/.zshrc`, or `~/.profile`.
- **Windows:**
  - Batch wrapper `~/.yggdrasil/bin/yggdrasil.cmd` invoking `node.exe ~/.yggdrasil/app/bin/yggdrasil.mjs %*`.
  - Adds `~/.yggdrasil/bin` to the current user's `PATH` via PowerShell environment configuration.

---

## 3. Bootstrap Scripts

### 3.1 POSIX (`install.sh`)
- One-line invocation: `curl -fsSL https://raw.githubusercontent.com/anjastatarigan/yggdrasil/main/install.sh | bash`
- Functions:
  1. Checks for prerequisites: `node` (>= 20.9.0), `git`, `pnpm` (offers `corepack enable pnpm` if missing).
  2. Ensures `~/.yggdrasil` directory structure.
  3. Clones repository into `~/.yggdrasil/app` on branch `main` (or uses existing clone if present).
  4. Delegates remaining installation to `node bin/yggdrasil.mjs install`.

### 3.2 Windows (`install.ps1`)
- One-line invocation: `irm https://raw.githubusercontent.com/anjastatarigan/yggdrasil/main/install.ps1 | iex`
- Functions:
  1. Validates PowerShell execution policy, Git, Node.js (>= 20.9.0), and pnpm.
  2. Clones to `$HOME/.yggdrasil/app` on branch `main`.
  3. Configures `%USERPROFILE%\.yggdrasil\bin` in the user's PATH.
  4. Invokes `yggdrasil.cmd install`.

---

## 4. CLI Command Specifications

The CLI entrypoint is `bin/yggdrasil.mjs` which loads modular TypeScript commands built with zero unnecessary third-party CLI dependencies.

### 4.1 `yggdrasil install`
```text
Usage: yggdrasil install [options]

Options:
  --port <number>     Set HTTP port (default: 2302)
  --dir <path>        Custom installation base path (default: ~/.yggdrasil)
  --no-service        Skip configuring auto-start OS background service
  --yes, -y           Non-interactive mode (accept all defaults)
```
**Execution Steps:**
1. Verifies Node.js version (`>= 20.9.0`).
2. Generates default `.env` file in `~/.yggdrasil/.env` with `PORT=2302`, `NODE_ENV=production`.
3. Sets up `~/.yggdrasil/data` symlink inside `app/data` to ensure zero database loss.
4. Executes `pnpm install --frozen-lockfile` and `pnpm build`.
5. Registers background service:
   - **Linux:** Generates `~/.config/systemd/user/yggdrasil.service`, reloads user daemon, and enables the unit.
   - **macOS:** Generates `~/Library/LaunchAgents/com.yggdrasil.server.plist` and loads via `launchctl`.
   - **Windows:** Creates Scheduled Task `Yggdrasil` set to run on user logon.
6. Starts the service and performs health check ping at `http://localhost:2302/api/settings`.

### 4.2 `yggdrasil update`
```text
Usage: yggdrasil update [options]

Options:
  --no-restart        Do not restart service after building
  --yes, -y           Skip confirmation prompt
```
**Execution Steps:**
1. **Safety Check:** Verifies no uncommitted changes exist in `~/.yggdrasil/app` (`git status --porcelain`).
2. **Pre-Update Backup:**
   - Snapshots `data/yggdrasil.db` to `data/yggdrasil.db.bak.<timestamp>`.
   - Records current Git commit SHA for rollback.
3. **Stop Service:** Halts current background service gracefully.
4. **Git Sync:** Fetches and checks out `main` branch explicitly (`git fetch origin main && git checkout main && git merge --ff-only origin/main`).
5. **Rebuild:** Runs `pnpm install` and `pnpm build`.
6. **Rollback Safeguard:**
   - If `pnpm build` fails:
     1. Automatically resets git to prior commit (`git reset --hard <sha>`).
     2. Restores database snapshot.
     3. Restarts service with previous working build.
     4. Exits with descriptive failure message and build logs.
7. **Restart & Health Check:** Starts updated service and verifies HTTP 200 response on port `2302`.

### 4.3 `yggdrasil uninstall`
```text
Usage: yggdrasil uninstall [options]

Options:
  --purge             Delete all user data, database, and logs without prompting
  --yes, -y           Confirm uninstall without interactive prompt
```
**Execution Steps:**
1. Stops and removes background service (`systemctl --user disable --now yggdrasil`, `launchctl unload`, or `schtasks /Delete`).
2. Removes service unit files from disk.
3. Removes CLI symlinks and PATH entries (`~/.local/bin/yggdrasil`, `~/.yggdrasil/bin`).
4. **Data Handling:**
   - If `--purge`: Deletes entire `~/.yggdrasil` directory.
   - If interactive: Prompts user: `Keep your database and configuration in ~/.yggdrasil/data? [Y/n]`. If kept, moves `data/` to `~/.yggdrasil-backup-<timestamp>`.

### 4.4 Service Management Commands
- `yggdrasil start`: Starts background service.
- `yggdrasil stop`: Stops background service.
- `yggdrasil restart`: Gracefully restarts service.
- `yggdrasil status`: Prints active state, listening port (2302), uptime, memory footprint, and commit version.
- `yggdrasil logs [-n <lines>] [-f]`: Displays or follows logs from `~/.yggdrasil/data/logs/`.

---

## 5. OS Daemon Service Configurations

### 5.1 Linux (`systemd --user`)
Unit template: `~/.config/systemd/user/yggdrasil.service`
```ini
[Unit]
Description=Yggdrasil Personal AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.yggdrasil/app
EnvironmentFile=%h/.yggdrasil/.env
ExecStart=/usr/bin/env pnpm start
Restart=always
RestartSec=5s
StandardOutput=append:%h/.yggdrasil/data/logs/yggdrasil.log
StandardError=append:%h/.yggdrasil/data/logs/yggdrasil.err.log

[Install]
WantedBy=default.target
```

### 5.2 macOS (`launchd`)
Property list: `~/Library/LaunchAgents/com.yggdrasil.server.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yggdrasil.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/pnpm</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/USER/.yggdrasil/app</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/USER/.yggdrasil/data/logs/yggdrasil.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USER/.yggdrasil/data/logs/yggdrasil.err.log</string>
</dict>
</plist>
```

### 5.3 Windows (`schtasks` + Wrapper)
- Scheduled Task command:
  ```powershell
  schtasks /Create /TN "Yggdrasil" /SC ONLOGON /TR "powershell.exe -WindowStyle Hidden -File $HOME\.yggdrasil\bin\start-background.ps1" /RL LIMITED /F
  ```
- Startup script `$HOME\.yggdrasil\bin\start-background.ps1`:
  - Sets working directory to `$HOME\.yggdrasil\app`.
  - Runs `pnpm start` with stdout/stderr redirected to `$HOME\.yggdrasil\data\logs\yggdrasil.log`.
  - Writes process ID to `$HOME\.yggdrasil\yggdrasil.pid`.

---

## 6. Testing & Quality Assurance Plan

1. **Unit Tests (`src/cli/__tests__/platform.test.ts`)**:
   - Verify generated systemd unit matches path specifications and env settings.
   - Verify macOS launchd plist XML structure and file descriptor redirects.
   - Verify Windows task commands.
2. **CLI Parsing Tests (`src/cli/__tests__/cli.test.ts`)**:
   - Verify option flags (`--port`, `--dir`, `--purge`, `--no-service`).
   - Verify port defaults to `2302`.
3. **Update & Rollback Tests (`src/cli/__tests__/update.test.ts`)**:
   - Test simulation of failed build triggers git reset and restores database backup.
   - Test dirty worktree detection aborts update cleanly.
4. **Uninstall Tests (`src/cli/__tests__/uninstall.test.ts`)**:
   - Test data preservation when `--purge` is absent.
   - Test full directory deletion when `--purge` is passed.
5. **Lint & Type Check**:
   - `pnpm tsc --noEmit`
   - `pnpm eslint`
   - Vitest suite run with zero regressions.
