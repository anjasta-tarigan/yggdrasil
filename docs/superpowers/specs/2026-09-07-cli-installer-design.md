# Architecture & Design Specification: Yggdrasil System CLI Installer

**Date:** 2026-09-07  
**Status:** Approved for Implementation (Post-Review Revision 2)  
**Target Environments:** Linux (`systemd --user`), macOS (`launchd`), Windows (`schtasks`)  
**Default Production Port:** `2302`  
**Target Installation Path:** `~/.yggdrasil` (`%USERPROFILE%\.yggdrasil` on Windows)

---

## 1. Executive Summary & Purpose

The Yggdrasil CLI installer provides a cross-platform, automated lifecycle management tool for self-hosting Yggdrasil. It enables zero-config installation, stable background execution across user sessions, atomic WAL-safe updates with automatic rollback, and clean uninstallation while strictly safeguarding persistent state (databases, provider credentials, custom skills, and plugins).

Distribution is handled via cryptographically verified curl/PowerShell bootstrap scripts that hand off to a unified Node.js/TypeScript CLI runner (`yggdrasil`), packaged directly with the repository.

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
  - Installer checks if `~/.local/bin` is already present in `$PATH` or in the user's shell rc file (`~/.bashrc`, `~/.zshrc`); if absent, it appends `export PATH="$HOME/.local/bin:$PATH"` idempotently (guarded by an explicit grep check before appending).
- **Windows:**
  - Wrapper batch script: `%USERPROFILE%\.yggdrasil\bin\yggdrasil.cmd` invoking `node.exe "%USERPROFILE%\.yggdrasil\app\bin\yggdrasil.mjs" %*`.
  - Adds `%USERPROFILE%\.yggdrasil\bin` to the current user's `PATH` via PowerShell environment configuration without duplicating existing entries.

---

## 3. Bootstrap Scripts & Cryptographic Integrity Verification

To eliminate supply chain tampering (e.g. Codecov-style CDN/origin manipulation), installer scripts verify integrity against expected SHA-256 release checksums before execution, and default to the latest stable release tag rather than the mutable `main` branch.

### 3.1 POSIX (`install.sh`)
- **Default Installation Flow with Checksum Verification:**
  ```bash
  # 1. Resolve release version (defaults to latest tagged release, or overrides with YGGDRASIL_VERSION)
  VERSION="${YGGDRASIL_VERSION:-$(curl -fsSL https://api.github.com/repos/anjastatarigan/yggdrasil/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')}"
  BASE_URL="https://github.com/anjastatarigan/yggdrasil/releases/download/${VERSION}"

  # 2. Download installer and signature/checksum
  curl -fsSL "${BASE_URL}/install.sh" -o /tmp/yggdrasil-install.sh
  curl -fsSL "${BASE_URL}/install.sh.sha256" -o /tmp/yggdrasil-install.sh.sha256

  # 3. Cryptographic integrity gate - aborts immediately on mismatch
  cd /tmp && (sha256sum -c yggdrasil-install.sh.sha256 || shasum -a 256 -c yggdrasil-install.sh.sha256) || {
    echo "ERROR: Checksum verification failed for Yggdrasil installer! Aborting." >&2
    exit 1
  }

  # 4. Execute verified installer
  bash /tmp/yggdrasil-install.sh --version "${VERSION}"
  ```
- **Development/Nightly Bypass:** Users explicitly desiring cutting-edge unreleased code can pass `YGGDRASIL_CHANNEL=main` to opt-out of tag pinning.

### 3.2 Windows (`install.ps1`)
- **PowerShell Verification Flow:**
  ```powershell
  $version = if ($env:YGGDRASIL_VERSION) { $env:YGGDRASIL_VERSION } else {
    (Invoke-RestMethod -Uri "https://api.github.com/repos/anjastatarigan/yggdrasil/releases/latest").tag_name
  }
  $baseUrl = "https://github.com/anjastatarigan/yggdrasil/releases/download/$version"
  $scriptPath = "$env:TEMP\yggdrasil-install.ps1"
  $hashPath = "$env:TEMP\yggdrasil-install.ps1.sha256"

  Invoke-WebRequest -Uri "$baseUrl/install.ps1" -OutFile $scriptPath
  Invoke-WebRequest -Uri "$baseUrl/install.ps1.sha256" -OutFile $hashPath

  $expectedHash = (Get-Content $hashPath).Trim().Split(" ")[0]
  $actualHash = (Get-FileHash -Path $scriptPath -Algorithm SHA256).Hash.ToLower()

  if ($expectedHash.ToLower() -ne $actualHash) {
    Write-Error "ERROR: Checksum verification failed for Yggdrasil installer! Aborting."
    exit 1
  }

  & $scriptPath -Version $version
  ```

---

## 4. Dedicated Health Check Endpoint

A minimal, dedicated endpoint `GET /api/health` in Next.js:
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
1. **Prerequisite Check:**
   - Verifies Node.js (`>= 20.9.0`) and Git.
   - Resolves absolute binary paths for `node` and `pnpm` (e.g. `/home/user/.local/share/pnpm/pnpm`).
2. **Directory & Symlink Setup:**
   - Creates `~/.yggdrasil/data/logs`, `data/skills`, `data/plugins`.
   - Creates `~/.yggdrasil/app/data` symlink pointing to `~/.yggdrasil/data`. If an existing symlink exists, safely validates or refreshes it without error (`ln -sf`).
   - Sets file permission `0600` on `data/providers.secrets.env` if present or generated.
3. **Environment Configuration:**
   - Generates `~/.yggdrasil/.env` (mode `0600`) with `PORT=2302`, `NODE_ENV=production`, and a freshly generated `APP_SECRET` (32 random bytes, hex-encoded).
   - `APP_SECRET` is required in production by both the env schema (`src/env.ts`) and the data-at-rest encryption layer (`src/lib/security/encryption.ts`), so the installer must generate it for a fresh production install to boot.
4. **Build & Prepare:**
   - Runs `pnpm install --frozen-lockfile` and `pnpm build`.
5. **Background Service Registration:**
   - **Linux:**
     - Runs `loginctl enable-linger "$USER"` (with non-fatal notice if sudo/admin policy prevents linger without root).
     - Generates `~/.config/systemd/user/yggdrasil.service` using the exact resolved absolute path for `pnpm` (e.g. `ExecStart=/path/to/pnpm start`) and explicit directory paths for `node` and `pnpm` in `Environment=PATH=...`.
     - Runs `systemctl --user daemon-reload` and `systemctl --user enable yggdrasil`.
   - **macOS:**
     - Renders `~/Library/LaunchAgents/com.yggdrasil.server.plist` with fully expanded absolute paths for user home (`os.homedir()`) and pnpm executable. Configures `KeepAlive -> SuccessfulExit: false`.
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
**Execution Steps (Reordered for Zero-Race WAL Safety):**
1. **Safety Check:** Verifies working tree in `~/.yggdrasil/app` is clean (`git status --porcelain`). If dirty, aborts with a message warning the user.
2. **Stop Service Gracefully (First):**
   - Halts running background service via platform manager (`systemctl --user stop yggdrasil`, `launchctl bootout`, or `schtasks /End`).
   - Waits for process exit via `process.kill(pid, 0)` check up to 10s.
   - **Guaranteed Result:** The application is completely offline, ensuring zero active SQLite transactions or concurrent writers.
3. **Atomic WAL-Safe Database Backup:**
   - Checkpoints SQLite WAL and copies all three database files:
     - `data/yggdrasil.db`
     - `data/yggdrasil.db-wal` (if present)
     - `data/yggdrasil.db-shm` (if present)
   - Stored in timestamped directory: `data/backups/backup-<timestamp>/`.
   - Records current Git commit SHA (`PREV_COMMIT`).
4. **Update Pipeline in Atomic Try/Catch:**
   - Wrapped in a single transactional block:
     ```typescript
     try {
       // Step A: Git sync (main branch)
       await exec("git fetch origin main");
       await exec("git checkout main");
       await exec("git merge --ff-only origin/main");

       // Step B: Dependencies & Build
       await exec("pnpm install");
       await exec("pnpm build");
     } catch (err) {
       // Step C: Rollback triggered on ANY failure
       await rollbackUpdate(prevCommit, backupPath);
       throw err;
     }
     ```
5. **Rollback Action (`rollbackUpdate`):**
   - Resets git branch: `git reset --hard PREV_COMMIT`.
   - Restores SQLite files (`.db`, `-wal`, `-shm`) from `data/backups/backup-<timestamp>/`.
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
- `yggdrasil start`:
  - Linux: `systemctl --user start yggdrasil`
  - macOS: `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.yggdrasil.server.plist`
  - Windows: `schtasks /Run /TN "Yggdrasil"`
- `yggdrasil stop`:
  - Linux: `systemctl --user stop yggdrasil`
  - macOS: `launchctl bootout gui/$UID ~/Library/LaunchAgents/com.yggdrasil.server.plist`
  - Windows: `schtasks /End /TN "Yggdrasil"`
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
Rendered dynamically using resolved absolute paths for `pnpm` and `node`:
`~/.config/systemd/user/yggdrasil.service`
```ini
[Unit]
Description=Yggdrasil Personal AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.yggdrasil/app
EnvironmentFile=%h/.yggdrasil/.env
Environment=PATH={{NODE_BIN_DIR}}:{{PNPM_BIN_DIR}}:/usr/local/bin:/usr/bin:/bin
ExecStart={{RESOLVED_PNPM_PATH}} start
Restart=always
RestartSec=5s
StandardOutput=append:%h/.yggdrasil/data/logs/yggdrasil.log
StandardError=append:%h/.yggdrasil/data/logs/yggdrasil.err.log

[Install]
WantedBy=default.target
```
*Note:* The installer executes `loginctl enable-linger "$USER"` during installation so the user daemon stays active across desktop logouts.

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
    <string>{{RESOLVED_PNPM_PATH}}</string>
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
   - Verify generated systemd unit matches path specifications, uses exact resolved `{{RESOLVED_PNPM_PATH}}`, and avoids unverified PATH guesses.
   - Verify macOS launchd plist XML structure uses `SuccessfulExit=false` for KeepAlive and contains fully expanded absolute paths without literal `~`.
   - Verify Windows task commands use `%USERPROFILE%` and valid quoting.
2. **SQLite WAL Backup Integrity Tests (`src/cli/__tests__/backup.test.ts`)**:
   - Verify that backup performed on a stopped service safely captures `.db`, `-wal`, and `-shm`.
   - Assert that restoring the snapshot yields valid, complete data and passes SQLite integrity check (`PRAGMA integrity_check`).
3. **CLI Options & Parsing Tests (`src/cli/__tests__/cli.test.ts`)**:
   - Verify option flags (`--port`, `--dir`, `--purge`, `--no-service`).
   - Verify default port is `2302`.
4. **Install Idempotency Tests (`src/cli/__tests__/install-idempotency.test.ts`)**:
   - Assert that running `yggdrasil install` twice does not duplicate PATH entries in shell rc files.
   - Assert that existing symlinks (`app/data`, `~/.local/bin/yggdrasil`) are overwritten cleanly (`ln -sf`) without throwing `EEXIST`.
5. **Update & Rollback Tests (`src/cli/__tests__/update.test.ts`)**:
   - Verify reordered sequence (Stop -> Backup -> Update).
   - Test that failure in `git fetch`, `pnpm install`, or `pnpm build` triggers full rollback of both git commit and database files and restarts previous working build.
   - Test dirty worktree detection aborts update cleanly before stopping the service.
6. **Uninstall Process Wait Tests (`src/cli/__tests__/uninstall.test.ts`)**:
   - Test that `uninstall` stops service via platform manager and waits for PID termination before moving/deleting data directories.
   - Verify data is preserved when `--purge` is omitted.
7. **Bootstrap Script Integrity Tests (`src/cli/__tests__/bootstrap-integrity.test.ts`)**:
   - Test that SHA-256 verification in `install.sh` and `install.ps1` successfully validates authentic assets and strictly rejects tampered scripts with exit code 1.
8. **Health Endpoint Test (`src/app/api/__tests__/health-api.test.ts`)**:
   - Test `GET /api/health` returns status `200` with expected payload.
