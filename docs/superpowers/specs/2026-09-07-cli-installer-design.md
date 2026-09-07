# Architecture & Design Specification: Yggdrasil System CLI Installer

**Date:** 2026-09-07  
**Status:** Approved for Implementation (Post-Review Revision)  
**Target Environments:** Linux (`systemd --user`), macOS (`launchd`), Windows (`schtasks`)  
**Default Production Port:** `2302`  
**Target Installation Path:** `~/.yggdrasil` (`%USERPROFILE%\.yggdrasil` on Windows)

---

## 1. Executive Summary & Purpose

The Yggdrasil CLI installer provides a cross-platform, automated lifecycle management tool for self-hosting Yggdrasil. It enables zero-config installation, stable background execution across user sessions, atomic WAL-safe updates with automatic rollback, and clean uninstallation while strictly safeguarding persistent state (databases, provider credentials, custom skills, and plugins).

Distribution is handled via curl/PowerShell bootstrap scripts that hand off to a unified Node.js/TypeScript CLI runner (`yggdrasil`), packaged directly with the repository.

---

## 2. System Architecture & Directory Layout

### 2.1 File System Structure

```
~/.yggdrasil/                  # Root user home directory
├── app/                       # Git clone of Yggdrasil codebase
│   ├── .next/                 # Production Next.js build
│   ├── bin/
│   │   └── yggdrasil.mjs      # Primary CLI runner executable
│   ├── data -> ../data        # Symlink: app/data points to ~/.yggdrasil/data
│   ├── package.json
│   └── pnpm-lock.yaml
├── data/                      # CANONICAL persistent state (preserved across all updates)
│   ├── yggdrasil.db           # SQLite primary database
│   ├── yggdrasil.db-wal       # SQLite Write-Ahead Log
│   ├── yggdrasil.db-shm       # SQLite Shared Memory index
│   ├── providers.secrets.env  # Plaintext API keys & provider credentials (mode 0600)
│   ├── logs/                  # System logs and daemon stdout/stderr
│   │   ├── yggdrasil.log
│   │   └── yggdrasil.err.log
│   ├── skills/                # Custom user skills
│   └── plugins/               # Active installed plugins
├── bin/                       # Windows command wrappers & executables
│   ├── yggdrasil.cmd
│   └── start-background.ps1
├── .env                       # Production runtime env (PORT=2302, NODE_ENV=production)
├── yggdrasil.pid              # Running process ID (for process tracking & fallback)
└── version.json               # Version metadata, install date, and git commit SHA
```

### 2.2 Symlink & Directory Clarification
- **Canonical Data Store:** All persistent data lives in the host directory `~/.yggdrasil/data`.
- **App Data Symlink:** `~/.yggdrasil/app/data` is created as a symlink pointing to `../data` (`~/.yggdrasil/data`). The Next.js app and SQLite connection read/write through `app/data`, but `app/` can be cleaned, pulled, or updated without touching persistent data.
- **Secrets Permissions:** `providers.secrets.env` is created with explicit `chmod 600` permissions (read/write by owner only) on POSIX systems to adhere to OWASP Secrets Management guidelines.

### 2.3 Executable Placement & PATH Integration
- **Linux & macOS:**
  - Symlink created: `~/.local/bin/yggdrasil` -> `~/.yggdrasil/app/bin/yggdrasil.mjs`.
  - Installer checks if `~/.local/bin` is in `$PATH`; if absent, it appends `export PATH="$HOME/.local/bin:$PATH"` to the user's shell rc file (`~/.bashrc` or `~/.zshrc`) idempotently (checking for prior existence before writing).
- **Windows:**
  - Wrapper batch script: `%USERPROFILE%\.yggdrasil\bin\yggdrasil.cmd` invoking `node.exe "%USERPROFILE%\.yggdrasil\app\bin\yggdrasil.mjs" %*`.
  - Adds `%USERPROFILE%\.yggdrasil\bin` to the current user's `PATH` via PowerShell environment configuration without duplicating existing entries.

---

## 3. Bootstrap Scripts & Integrity Verification

To protect against untrusted script execution and supply chain tampering (e.g. Codecov-style CDN/origin manipulation):

### 3.1 POSIX (`install.sh`)
- Default usage:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/anjastatarigan/yggdrasil/main/install.sh -o /tmp/yggdrasil-install.sh && \
  bash /tmp/yggdrasil-install.sh
  ```
- **Integrity & Verification:**
  - Checks Node.js version (`>= 20.9.0`), Git, and pnpm.
  - Clones or checks out repository on branch `main` into `~/.yggdrasil/app`.
  - If a release tag is provided (`YGGDRASIL_VERSION=v1.0.0`), checks out that exact immutable Git tag rather than `main`.
  - Runs self-integrity check on downloaded installation files before executing `node bin/yggdrasil.mjs install`.

### 3.2 Windows (`install.ps1`)
- Default usage:
  ```powershell
  Invoke-WebRequest -Uri "https://raw.githubusercontent.com/anjastatarigan/yggdrasil/main/install.ps1" -OutFile "$env:TEMP\yggdrasil-install.ps1"; & "$env:TEMP\yggdrasil-install.ps1"
  ```
- Functions:
  - Validates PowerShell execution policy, Git, Node.js (`>= 20.9.0`), and pnpm.
  - Clones to `$env:USERPROFILE\.yggdrasil\app`.
  - Registers PATH and hands off to `yggdrasil.cmd install`.

---

## 4. Dedicated Health Check Endpoint

A minimal, dedicated endpoint `GET /api/health` will be added to the Next.js server:
- Returns `200 OK` with `{ status: "ok", timestamp: number, version: string }`.
- Requires zero database writes and exposes no sensitive server configuration or secrets (unlike `/api/settings`).
- Used by `yggdrasil install`, `update`, and `status` to reliably verify HTTP readiness.

---

## 5. CLI Command Specifications

The CLI entrypoint is `bin/yggdrasil.mjs` which dispatches to modular TypeScript commands.

### 5.1 `yggdrasil install`
```text
Usage: yggdrasil install [options]

Options:
  --port <number>     Set HTTP port (default: 2302)
  --dir <path>        Custom installation base path (default: ~/.yggdrasil)
  --no-service        Skip configuring auto-start OS background service
  --yes, -y           Non-interactive mode (accept all defaults)
```
**Execution Steps:**
1. **Prerequisite Check:** Verifies Node.js (`>= 20.9.0`), Git, and resolves absolute paths to `node` and `pnpm`.
2. **Directory & Symlink Setup:**
   - Creates `~/.yggdrasil/data/logs`, `data/skills`, `data/plugins`.
   - Creates `~/.yggdrasil/app/data` symlink pointing to `~/.yggdrasil/data`.
   - Sets file permission `0600` on `data/providers.secrets.env` if present or generated.
3. **Environment Configuration:**
   - Generates `~/.yggdrasil/.env` with `PORT=2302`, `NODE_ENV=production`.
4. **Build & Prepare:**
   - Runs `pnpm install --frozen-lockfile` and `pnpm build`.
5. **Background Service Registration:**
   - **Linux:**
     - Runs `loginctl enable-linger "$USER"` (with non-fatal warning to user if sudo/admin policy prevents linger without root).
     - Resolves the exact binary path and `$PATH` containing `pnpm` and `node`.
     - Writes `~/.config/systemd/user/yggdrasil.service`.
     - Runs `systemctl --user daemon-reload` and `systemctl --user enable yggdrasil`.
   - **macOS:**
     - Renders `~/Library/LaunchAgents/com.yggdrasil.server.plist` with fully expanded absolute paths for user home (`os.homedir()`) and pnpm executable.
     - Loads agent via `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yggdrasil.server.plist` (or `launchctl load`).
   - **Windows:**
     - Creates Scheduled Task `Yggdrasil` with expanded `%USERPROFILE%` paths set to run at logon (`/SC ONLOGON /RL LIMITED`).
6. **Start & Verify:**
   - Starts service via platform manager and polls `http://localhost:2302/api/health` up to 30s.

### 5.2 `yggdrasil update`
```text
Usage: yggdrasil update [options]

Options:
  --no-restart        Do not restart service after building
  --yes, -y           Skip confirmation prompt
```
**Execution Steps:**
1. **Safety Check:** Verifies working tree in `~/.yggdrasil/app` is clean (`git status --porcelain`). If dirty, aborts with a message warning the user.
2. **WAL-Safe SQLite Backup:**
   - Connects to SQLite database or runs `better-sqlite3` online backup API `.backup(backupPath)`.
   - Alternatively, executes `PRAGMA wal_checkpoint(TRUNCATE)` and atomically copies `yggdrasil.db`, `yggdrasil.db-wal` (if any), and `yggdrasil.db-shm` into `data/backup-<timestamp>/`.
   - Records current Git commit SHA (`PREV_COMMIT`).
3. **Stop Service:** Gracefully stops the running service via the platform manager (`systemctl --user stop yggdrasil` or `launchctl bootout`).
4. **Update Pipeline in Atomic Try/Catch:**
   - Wrapped in a single transactional block:
     ```typescript
     try {
       // Step A: Git sync
       await exec("git fetch origin main");
       await exec("git checkout main");
       await exec("git merge --ff-only origin/main");

       // Step B: Dependencies & Build
       await exec("pnpm install");
       await exec("pnpm build");
     } catch (err) {
       // Rollback triggered
       await rollbackUpdate(prevCommit, backupPath);
       throw err;
     }
     ```
5. **Rollback Action (`rollbackUpdate`):**
   - Resets git branch: `git reset --hard PREV_COMMIT`.
   - Restores SQLite `.db`, `-wal`, and `-shm` from `data/backup-<timestamp>/`.
   - Restarts the previous working build via the service manager.
   - Emits structured error log explaining what failed (git sync, dependency install, or build).
6. **Restart & Health Check:**
   - Starts service via service manager.
   - Polls `http://localhost:2302/api/health` until ready.

### 5.3 `yggdrasil uninstall`
```text
Usage: yggdrasil uninstall [options]

Options:
  --purge             Delete all user data, database, and logs without prompting
  --yes, -y           Confirm uninstall without interactive prompt
```
**Execution Steps:**
1. **Stop & Terminate Service:**
   - Invokes platform manager: `systemctl --user stop yggdrasil` and `systemctl --user disable yggdrasil` (Linux), `launchctl bootout gui/$UID/<plist>` (macOS), or `schtasks /End /TN "Yggdrasil"` + `schtasks /Delete /TN "Yggdrasil" /F` (Windows).
   - **Process Exit Wait:** Reads `yggdrasil.pid` if present and polls `process.kill(pid, 0)` up to 10 seconds to guarantee the process has fully exited and released SQLite file locks before modifying data.
2. **Remove Service Files:**
   - Deletes `~/.config/systemd/user/yggdrasil.service` or macOS plist.
3. **Remove PATH & Executables:**
   - Deletes `~/.local/bin/yggdrasil` symlink.
   - Cleans up Windows PATH entry and `yggdrasil.cmd`.
4. **Data Handling:**
   - If `--purge`: Deletes entire `~/.yggdrasil` directory.
   - If without `--purge`: Prompts user: `Keep your database and configuration in ~/.yggdrasil/data? [Y/n]`. If kept, archives `data/` to `~/.yggdrasil-backup-<timestamp>` and deletes `app/`.

### 5.4 Service Management Commands
To avoid conflicts with service manager restart policies:
- `yggdrasil start`:
  - Linux: `systemctl --user start yggdrasil`
  - macOS: `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yggdrasil.server.plist`
  - Windows: `schtasks /Run /TN "Yggdrasil"`
- `yggdrasil stop`:
  - Linux: `systemctl --user stop yggdrasil` (prevents `Restart=always` from re-triggering)
  - macOS: `launchctl bootout gui/$UID ~/Library/LaunchAgents/com.yggdrasil.server.plist` (prevents `KeepAlive` from re-triggering)
  - Windows: `schtasks /End /TN "Yggdrasil"` and process termination via PID file
- `yggdrasil restart`:
  - Linux: `systemctl --user restart yggdrasil`
  - macOS: `yggdrasil stop` followed by `yggdrasil start`
  - Windows: `yggdrasil stop` followed by `yggdrasil start`
- `yggdrasil status`:
  - Queries platform service state + checks `GET http://localhost:2302/api/health`.
  - Displays: Service State (Active/Inactive), PID, HTTP Health, Port (2302), and Git Commit Version.
- `yggdrasil logs [-n <lines>] [-f]`:
  - Linux: Reads or follows `journalctl --user -u yggdrasil` (or falls back to `~/.yggdrasil/data/logs/yggdrasil.log`).
  - macOS / Windows: Reads or follows `~/.yggdrasil/data/logs/yggdrasil.log`.

---

## 6. OS Daemon Service Configurations

### 6.1 Linux (`systemd --user`)
Unit template: `~/.config/systemd/user/yggdrasil.service`
```ini
[Unit]
Description=Yggdrasil Personal AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.yggdrasil/app
EnvironmentFile=%h/.yggdrasil/.env
Environment=PATH=/usr/local/bin:/usr/bin:%h/.local/bin:%h/.local/share/pnpm:%h/.nvm/current/bin:%h/.fnm/current/bin:$PATH
ExecStart=/usr/bin/env pnpm start
Restart=always
RestartSec=5s
StandardOutput=append:%h/.yggdrasil/data/logs/yggdrasil.log
StandardError=append:%h/.yggdrasil/data/logs/yggdrasil.err.log

[Install]
WantedBy=default.target
```
*Note:* The installer calls `loginctl enable-linger "$USER"` during installation to ensure background execution continues when the user logs out.

### 6.2 macOS (`launchd`)
Rendered dynamically at install time with expanded absolute paths (no literal `~`):
`~/Library/LaunchAgents/com.yggdrasil.server.plist`
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yggdrasil.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{PNPM_PATH}}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{{HOME}}/.yggdrasil/app</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{{HOME}}/.yggdrasil/data/logs/yggdrasil.log</string>
  <key>StandardErrorPath</key>
  <string>{{HOME}}/.yggdrasil/data/logs/yggdrasil.err.log</string>
</dict>
</plist>
```
*Note:* Setting `SuccessfulExit=false` under `KeepAlive` ensures that when the server exits cleanly (exit code 0), `launchd` does not immediately respawn it, allowing clean shutdowns.

### 6.3 Windows (`schtasks` + Wrapper)
- Scheduled Task command generated with expanded paths:
  ```cmd
  schtasks /Create /TN "Yggdrasil" /SC ONLOGON /TR "powershell.exe -NoProfile -WindowStyle Hidden -File \"%USERPROFILE%\.yggdrasil\bin\start-background.ps1\"" /RL LIMITED /F
  ```
- Startup script `%USERPROFILE%\.yggdrasil\bin\start-background.ps1`:
  - Sets location to `$env:USERPROFILE\.yggdrasil\app`.
  - Spawns `pnpm start` process with stdout/stderr directed to `..\data\logs\yggdrasil.log`.
  - Writes process ID to `..\yggdrasil.pid`.

---

## 7. Testing & Quality Assurance Plan

1. **Unit Tests (`src/cli/__tests__/platform.test.ts`)**:
   - Verify generated systemd unit matches path specifications, includes expanded PATH, and configures user lingering.
   - Verify macOS launchd plist XML structure uses `SuccessfulExit=false` for KeepAlive and contains fully expanded absolute paths without literal `~`.
   - Verify Windows task commands use `%USERPROFILE%` and valid quoting.
2. **SQLite WAL Backup Integrity Tests (`src/cli/__tests__/backup.test.ts`)**:
   - Simulate active WAL database with concurrent writes.
   - Run backup helper and verify that restoring the snapshot yields valid, complete data and passes SQLite integrity check (`PRAGMA integrity_check`).
3. **CLI Options & Parsing Tests (`src/cli/__tests__/cli.test.ts`)**:
   - Verify option flags (`--port`, `--dir`, `--purge`, `--no-service`).
   - Verify default port is `2302`.
4. **Update & Rollback Tests (`src/cli/__tests__/update.test.ts`)**:
   - Test that failure in `git fetch`, `pnpm install`, or `pnpm build` triggers full rollback of both git commit and database files.
   - Test dirty worktree detection aborts update cleanly.
5. **Uninstall Process Wait Tests (`src/cli/__tests__/uninstall.test.ts`)**:
   - Test that `uninstall` stops service via platform manager and waits for PID termination before moving/deleting data directories.
   - Verify data is preserved when `--purge` is omitted.
6. **Health Endpoint Test (`src/app/api/__tests__/health-api.test.ts`)**:
   - Test `GET /api/health` returns status `200` with expected payload.
