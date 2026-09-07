# Yggdrasil System CLI Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a robust, cross-platform CLI installer (`install`, `update`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`) for Yggdrasil supporting Linux (`systemd --user`), macOS (`launchd`), and Windows (`schtasks`) with zero-race WAL-safe backups, user lingering, dedicated health checks, and cryptographic verification.

**Architecture:** A lightweight bootstrap script pair (`install.sh` / `install.ps1`) verifies SHA-256 release checksums and delegates to an integrated TypeScript CLI entrypoint (`bin/yggdrasil.mjs` -> `src/cli/`). Persistent user state (`~/.yggdrasil/data`) is isolated from the application code (`~/.yggdrasil/app`), while OS daemon managers govern background lifecycle.

**Tech Stack:** TypeScript, Node.js (>= 20.9.0), Next.js 16, better-sqlite3 / SQLite WAL, Vitest, bash, PowerShell.

**Spec:** `docs/superpowers/specs/2026-09-07-cli-installer-design.md`

## Global Constraints

- Default production HTTP port: `2302`.
- Base install directory: `~/.yggdrasil` (Linux/macOS) or `%USERPROFILE%\.yggdrasil` (Windows).
- Single source of truth for persistent data: `~/.yggdrasil/data`, with `~/.yggdrasil/app/data` symlinked to it.
- Secrets permissions: `chmod 600` on `providers.secrets.env`.
- Database backup safety: Always stop service before backup, and backup `.db`, `-wal`, and `-shm`.
- Zero concurrent vitest executions: Keep test runs focused and sequential.

---

## File Structure

```
src/
├── app/api/health/
│   └── route.ts                      # Minimal, non-sensitive health check endpoint
├── app/api/__tests__/
│   └── health-api.test.ts            # Unit tests for GET /api/health
├── cli/
│   ├── types.ts                      # CLI configuration, options, and status interfaces
│   ├── utils/
│   │   ├── paths.ts                  # Cross-platform path expansion, symlink helpers, permission setters
│   │   ├── exec.ts                   # Process execution wrappers with timeout and capture
│   │   ├── backup.ts                 # WAL-safe SQLite backup and restore routines
│   │   └── health.ts                 # HTTP polling client for /api/health
│   ├── platform/
│   │   ├── index.ts                  # ServiceManager interface & factory
│   │   ├── systemd.ts                # Linux systemd --user service manager + linger
│   │   ├── launchd.ts                # macOS launchd plist generator + service manager
│   │   └── windows.ts                # Windows schtasks + PowerShell background manager
│   ├── commands/
│   │   ├── install.ts                # "yggdrasil install" orchestration
│   │   ├── update.ts                 # "yggdrasil update" (stop -> backup -> sync -> build -> rollback on err)
│   │   ├── uninstall.ts              # "yggdrasil uninstall" (stop -> pid wait -> purge/archive)
│   │   └── service.ts                # "start", "stop", "restart", "status", "logs"
│   └── index.ts                      # CLI router & argument dispatcher
bin/
├── yggdrasil.mjs                     # Node executable CLI wrapper (#!/usr/bin/env node)
├── yggdrasil.cmd                     # Windows batch command runner
└── start-background.ps1              # Windows background detached launcher
install.sh                            # POSIX curl/bash bootstrap installer with sha256 check
install.ps1                           # Windows PowerShell bootstrap installer with sha256 check
```

---

### Task 1: Dedicated Health Check Endpoint (`GET /api/health`)

**Files:**
- Create: `src/app/api/health/route.ts`
- Test: `src/app/api/__tests__/health-api.test.ts`

**Interfaces:**
- Produces: `GET(request: Request): Promise<NextResponse<{ status: "ok"; timestamp: number; version: string }>>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/app/api/__tests__/health-api.test.ts
import { describe, it, expect } from "vitest";
import { GET } from "../health/route";

describe("Health API Handler", () => {
  it("GET /api/health returns status 200 with status ok and version", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("number");
    expect(typeof body.version).toBe("string");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/__tests__/health-api.test.ts`  
Expected: FAIL with module not found for `../health/route`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/app/api/health/route.ts
import { NextResponse } from "next/server";
import pkg from "../../../../package.json";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      timestamp: Date.now(),
      version: pkg.version || "0.1.0",
    },
    { status: 200 }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/__tests__/health-api.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/health/route.ts src/app/api/__tests__/health-api.test.ts
git commit -m "feat(api): add dedicated /api/health endpoint for CLI health checks"
```

---

### Task 2: Core CLI Path Utilities & Permissions (`src/cli/utils/paths.ts`)

**Files:**
- Create: `src/cli/types.ts`
- Create: `src/cli/utils/paths.ts`
- Test: `src/cli/__tests__/paths.test.ts`

**Interfaces:**
- Produces:
  - `resolveInstallPaths(customBaseDir?: string): InstallPaths`
  - `ensureSecurePermissions(filePath: string): Promise<void>`
  - `ensureSymlink(target: string, symlinkPath: string): Promise<void>`
  - `addPathToProfile(binDir: string, profilePath?: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/__tests__/paths.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveInstallPaths, ensureSymlink, addPathToProfile } from "../utils/paths";

describe("CLI Path Utilities", () => {
  const tmpDir = path.join(os.tmpdir(), "ygg-paths-test-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves default directory hierarchy correctly", () => {
    const paths = resolveInstallPaths(tmpDir);
    expect(paths.baseDir).toBe(tmpDir);
    expect(paths.appDir).toBe(path.join(tmpDir, "app"));
    expect(paths.dataDir).toBe(path.join(tmpDir, "data"));
    expect(paths.logsDir).toBe(path.join(tmpDir, "data", "logs"));
    expect(paths.envFile).toBe(path.join(tmpDir, ".env"));
    expect(paths.pidFile).toBe(path.join(tmpDir, "yggdrasil.pid"));
  });

  it("creates and overwrites symlinks safely without throwing EEXIST", async () => {
    const targetDir = path.join(tmpDir, "target");
    const linkPath = path.join(tmpDir, "link");
    await fs.mkdir(targetDir, { recursive: true });

    await ensureSymlink(targetDir, linkPath);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    // Call again to verify idempotency
    await ensureSymlink(targetDir, linkPath);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("appends to profile idempotently without duplicating PATH entries", async () => {
    const profile = path.join(tmpDir, ".bashrc");
    const binDir = path.join(tmpDir, "bin");
    await fs.writeFile(profile, "# User bashrc\n", "utf8");

    const added1 = await addPathToProfile(binDir, profile);
    expect(added1).toBe(true);
    const content1 = await fs.readFile(profile, "utf8");
    expect(content1).toContain(binDir);

    const added2 = await addPathToProfile(binDir, profile);
    expect(added2).toBe(false); // Already present
    const occurrences = content1.split(binDir).length - 1;
    expect(occurrences).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/paths.test.ts`  
Expected: FAIL with module not found for `../utils/paths`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/types.ts
export interface InstallPaths {
  baseDir: string;
  appDir: string;
  dataDir: string;
  logsDir: string;
  skillsDir: string;
  pluginsDir: string;
  envFile: string;
  pidFile: string;
  binDir: string;
}

export interface CliOptions {
  port?: number;
  dir?: string;
  noService?: boolean;
  yes?: boolean;
  purge?: boolean;
}
```

```typescript
// src/cli/utils/paths.ts
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { InstallPaths } from "../types";

export function resolveInstallPaths(customBaseDir?: string): InstallPaths {
  const baseDir = customBaseDir ? path.resolve(customBaseDir) : path.join(os.homedir(), ".yggdrasil");
  const dataDir = path.join(baseDir, "data");
  return {
    baseDir,
    appDir: path.join(baseDir, "app"),
    dataDir,
    logsDir: path.join(dataDir, "logs"),
    skillsDir: path.join(dataDir, "skills"),
    pluginsDir: path.join(dataDir, "plugins"),
    envFile: path.join(baseDir, ".env"),
    pidFile: path.join(baseDir, "yggdrasil.pid"),
    binDir: path.join(baseDir, "bin"),
  };
}

export async function ensureSecurePermissions(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Ignore if file doesn't exist yet
    }
  }
}

export async function ensureSymlink(target: string, symlinkPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(symlinkPath);
    if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
      await fs.rm(symlinkPath, { recursive: true, force: true });
    }
  } catch {
    // Does not exist
  }
  await fs.symlink(target, symlinkPath, process.platform === "win32" ? "junction" : "dir");
}

export async function addPathToProfile(binDir: string, customProfilePath?: string): Promise<boolean> {
  const profile = customProfilePath || path.join(os.homedir(), ".bashrc");
  let content = "";
  try {
    content = await fs.readFile(profile, "utf8");
  } catch {
    content = "";
  }

  if (content.includes(binDir)) {
    return false;
  }

  const exportLine = `\n# Yggdrasil CLI PATH\nexport PATH="${binDir}:$PATH"\n`;
  await fs.appendFile(profile, exportLine, "utf8");
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/__tests__/paths.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/types.ts src/cli/utils/paths.ts src/cli/__tests__/paths.test.ts
git commit -m "feat(cli): add path resolution, secure permissions, and profile management"
```

---

### Task 3: Zero-Race SQLite WAL Backup & Rollback Utility (`src/cli/utils/backup.ts`)

**Files:**
- Create: `src/cli/utils/backup.ts`
- Test: `src/cli/__tests__/backup.test.ts`

**Interfaces:**
- Produces:
  - `backupDatabaseFiles(dataDir: string, backupDestDir: string): Promise<string[]>`
  - `restoreDatabaseFiles(backupSourceDir: string, dataDir: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/__tests__/backup.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { backupDatabaseFiles, restoreDatabaseFiles } from "../utils/backup";

describe("SQLite WAL-Safe Backup and Restore", () => {
  const tmpDir = path.join(os.tmpdir(), "ygg-backup-test-" + Date.now());
  const dataDir = path.join(tmpDir, "data");
  const backupDir = path.join(tmpDir, "backups");

  beforeEach(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("safely backs up and restores .db, -wal, and -shm files", async () => {
    const dbPath = path.join(dataDir, "yggdrasil.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);");
    db.exec("INSERT INTO items (name) VALUES ('original');");
    db.close();

    // Create companion files if not automatically created
    const walPath = path.join(dataDir, "yggdrasil.db-wal");
    const shmPath = path.join(dataDir, "yggdrasil.db-shm");
    if (!(await fs.stat(walPath).catch(() => false))) {
      await fs.writeFile(walPath, "dummy-wal", "utf8");
    }
    if (!(await fs.stat(shmPath).catch(() => false))) {
      await fs.writeFile(shmPath, "dummy-shm", "utf8");
    }

    const backedUp = await backupDatabaseFiles(dataDir, backupDir);
    expect(backedUp.length).toBeGreaterThanOrEqual(1);

    // Now corrupt/modify original DB
    const db2 = new Database(dbPath);
    db2.exec("INSERT INTO items (name) VALUES ('corrupted_or_newer');");
    db2.close();

    // Restore from backup
    await restoreDatabaseFiles(backupDir, dataDir);

    const db3 = new Database(dbPath);
    const rows = db3.prepare("SELECT name FROM items").all() as { name: string }[];
    db3.close();

    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("original");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/backup.test.ts`  
Expected: FAIL with module not found for `../utils/backup`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/utils/backup.ts
import fs from "node:fs/promises";
import path from "node:path";

const DB_COMPANIONS = ["yggdrasil.db", "yggdrasil.db-wal", "yggdrasil.db-shm"];

export async function backupDatabaseFiles(dataDir: string, backupDestDir: string): Promise<string[]> {
  await fs.mkdir(backupDestDir, { recursive: true });
  const copiedFiles: string[] = [];

  for (const filename of DB_COMPANIONS) {
    const src = path.join(dataDir, filename);
    const dest = path.join(backupDestDir, filename);
    try {
      await fs.copyFile(src, dest);
      copiedFiles.push(filename);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }

  return copiedFiles;
}

export async function restoreDatabaseFiles(backupSourceDir: string, dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });

  for (const filename of DB_COMPANIONS) {
    const src = path.join(backupSourceDir, filename);
    const dest = path.join(dataDir, filename);
    try {
      await fs.copyFile(src, dest);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // If the backup didn't have a -wal or -shm, remove any stale one in dataDir
        await fs.rm(dest, { force: true });
      } else {
        throw err;
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/__tests__/backup.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/utils/backup.ts src/cli/__tests__/backup.test.ts
git commit -m "feat(cli): add atomic SQLite WAL backup and restore routines"
```

---

### Task 4: Process Execution & Health Polling Utilities (`src/cli/utils/exec.ts` & `health.ts`)

**Files:**
- Create: `src/cli/utils/exec.ts`
- Create: `src/cli/utils/health.ts`
- Test: `src/cli/__tests__/exec-health.test.ts`

**Interfaces:**
- Produces:
  - `runCommand(cmd: string, args: string[], options?: ExecOptions): Promise<ExecResult>`
  - `waitForHealth(url: string, timeoutMs?: number, pollIntervalMs?: number): Promise<boolean>`
  - `waitForProcessExit(pid: number, timeoutMs?: number): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/__tests__/exec-health.test.ts
import { describe, it, expect, vi } from "vitest";
import { runCommand } from "../utils/exec";
import { waitForHealth, waitForProcessExit } from "../utils/health";

describe("Execution and Health Check Utilities", () => {
  it("executes basic commands and captures output", async () => {
    const res = await runCommand(process.execPath, ["-e", "console.log('hello yggdrasil')"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hello yggdrasil");
  });

  it("handles non-zero exit codes cleanly", async () => {
    const res = await runCommand(process.execPath, ["-e", "process.exit(2)"]);
    expect(res.code).toBe(2);
  });

  it("waits for health check successfully when endpoint returns 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    });
    global.fetch = fetchMock;

    const healthy = await waitForHealth("http://localhost:2302/api/health", 1000, 50);
    expect(healthy).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns false if health check times out", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const healthy = await waitForHealth("http://localhost:2302/api/health", 200, 50);
    expect(healthy).toBe(false);
  });

  it("detects process exit when process is no longer running", async () => {
    // Non-existent PID
    const exited = await waitForProcessExit(99999999, 500);
    expect(exited).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/exec-health.test.ts`  
Expected: FAIL with module not found for `../utils/exec`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/utils/exec.ts
import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(cmd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}
```

```typescript
// src/cli/utils/health.ts
export async function waitForHealth(url: string, timeoutMs = 30000, pollIntervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body?.status === "ok") {
          return true;
        }
      }
    } catch {
      // In-flight connection failure, retry
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return false;
}

export async function waitForProcessExit(pid: number, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0); // Throws if process doesn't exist
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return true; // Process exited
    }
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/__tests__/exec-health.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/utils/exec.ts src/cli/utils/health.ts src/cli/__tests__/exec-health.test.ts
git commit -m "feat(cli): add command execution runner and health/PID polling utilities"
```

---

### Task 5: Platform Service Managers (`systemd`, `launchd`, `windows`)

**Files:**
- Create: `src/cli/platform/index.ts`
- Create: `src/cli/platform/systemd.ts`
- Create: `src/cli/platform/launchd.ts`
- Create: `src/cli/platform/windows.ts`
- Test: `src/cli/__tests__/platform.test.ts`

**Interfaces:**
- Produces:
  - `interface ServiceManager`: `installService()`, `uninstallService()`, `start()`, `stop()`, `restart()`, `status()`
  - `getServiceManager(platform?: string): ServiceManager`
  - Linux: renders `systemd.service` with exact absolute `pnpm` path and runs `loginctl enable-linger`
  - macOS: renders `plist` with `SuccessfulExit: false` and absolute paths
  - Windows: creates scheduled task with `%USERPROFILE%` and `start-background.ps1`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/__tests__/platform.test.ts
import { describe, it, expect } from "vitest";
import { generateSystemdUnit } from "../platform/systemd";
import { generateLaunchdPlist } from "../platform/launchd";
import { generateWindowsTaskCommand } from "../platform/windows";

describe("Platform Service Configurations", () => {
  it("generates systemd unit with exact pnpm path and no guessed PATH fallbacks", () => {
    const unit = generateSystemdUnit({
      appDir: "/home/test/.yggdrasil/app",
      envFile: "/home/test/.yggdrasil/.env",
      logsDir: "/home/test/.yggdrasil/data/logs",
      pnpmPath: "/home/test/.local/share/pnpm/pnpm",
      nodeBinDir: "/usr/local/bin",
      pnpmBinDir: "/home/test/.local/share/pnpm",
    });

    expect(unit).toContain("ExecStart=/home/test/.local/share/pnpm/pnpm start");
    expect(unit).toContain("WorkingDirectory=%h/.yggdrasil/app");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("EnvironmentFile=%h/.yggdrasil/.env");
    expect(unit).toContain("PATH=/usr/local/bin:/home/test/.local/share/pnpm");
  });

  it("generates launchd plist with SuccessfulExit=false and no literal tilde", () => {
    const plist = generateLaunchdPlist({
      appDir: "/Users/test/.yggdrasil/app",
      logsDir: "/Users/test/.yggdrasil/data/logs",
      pnpmPath: "/opt/homebrew/bin/pnpm",
      homeDir: "/Users/test",
    });

    expect(plist).not.toContain("~");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<string>/opt/homebrew/bin/pnpm</string>");
    expect(plist).toContain("<string>/Users/test/.yggdrasil/data/logs/yggdrasil.log</string>");
  });

  it("generates Windows schtasks command with %USERPROFILE% and /RL LIMITED", () => {
    const cmd = generateWindowsTaskCommand();
    expect(cmd).toContain("schtasks /Create /TN \"Yggdrasil\"");
    expect(cmd).toContain("/SC ONLOGON");
    expect(cmd).toContain("/RL LIMITED");
    expect(cmd).toContain("%USERPROFILE%\\.yggdrasil\\bin\\start-background.ps1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/platform.test.ts`  
Expected: FAIL with module not found for `../platform/systemd`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/platform/index.ts
import type { InstallPaths } from "../types";
import { SystemdManager } from "./systemd";
import { LaunchdManager } from "./launchd";
import { WindowsManager } from "./windows";

export interface ServiceManager {
  installService(paths: InstallPaths, port: number): Promise<void>;
  uninstallService(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<{ active: boolean; details?: string }>;
}

export function getServiceManager(platform = process.platform): ServiceManager {
  if (platform === "linux") return new SystemdManager();
  if (platform === "darwin") return new LaunchdManager();
  if (platform === "win32") return new WindowsManager();
  throw new Error(`Unsupported platform: ${platform}`);
}
```

```typescript
// src/cli/platform/systemd.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

export interface SystemdConfigOptions {
  appDir: string;
  envFile: string;
  logsDir: string;
  pnpmPath: string;
  nodeBinDir: string;
  pnpmBinDir: string;
}

export function generateSystemdUnit(options: SystemdConfigOptions): string {
  return `[Unit]
Description=Yggdrasil Personal AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/.yggdrasil/app
EnvironmentFile=%h/.yggdrasil/.env
Environment=PATH=${options.nodeBinDir}:${options.pnpmBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${options.pnpmPath} start
Restart=always
RestartSec=5s
StandardOutput=append:%h/.yggdrasil/data/logs/yggdrasil.log
StandardError=append:%h/.yggdrasil/data/logs/yggdrasil.err.log

[Install]
WantedBy=default.target
`;
}

export class SystemdManager implements ServiceManager {
  private unitPath = path.join(os.homedir(), ".config", "systemd", "user", "yggdrasil.service");

  async installService(paths: InstallPaths): Promise<void> {
    // Enable lingering
    const username = os.userInfo().username;
    await runCommand("loginctl", ["enable-linger", username]);

    const pnpmRes = await runCommand("which", ["pnpm"]);
    const pnpmPath = pnpmRes.code === 0 ? pnpmRes.stdout.trim() : "/usr/local/bin/pnpm";
    const pnpmBinDir = path.dirname(pnpmPath);
    const nodeBinDir = path.dirname(process.execPath);

    const unit = generateSystemdUnit({
      appDir: paths.appDir,
      envFile: paths.envFile,
      logsDir: paths.logsDir,
      pnpmPath,
      nodeBinDir,
      pnpmBinDir,
    });

    await fs.mkdir(path.dirname(this.unitPath), { recursive: true });
    await fs.writeFile(this.unitPath, unit, "utf8");

    await runCommand("systemctl", ["--user", "daemon-reload"]);
    await runCommand("systemctl", ["--user", "enable", "yggdrasil"]);
  }

  async uninstallService(): Promise<void> {
    await runCommand("systemctl", ["--user", "stop", "yggdrasil"]);
    await runCommand("systemctl", ["--user", "disable", "yggdrasil"]);
    await fs.rm(this.unitPath, { force: true });
    await runCommand("systemctl", ["--user", "daemon-reload"]);
  }

  async start(): Promise<void> {
    await runCommand("systemctl", ["--user", "start", "yggdrasil"]);
  }

  async stop(): Promise<void> {
    await runCommand("systemctl", ["--user", "stop", "yggdrasil"]);
  }

  async restart(): Promise<void> {
    await runCommand("systemctl", ["--user", "restart", "yggdrasil"]);
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("systemctl", ["--user", "is-active", "yggdrasil"]);
    const active = res.stdout.trim() === "active";
    return { active, details: res.stdout.trim() };
  }
}
```

```typescript
// src/cli/platform/launchd.ts
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

export interface LaunchdConfigOptions {
  appDir: string;
  logsDir: string;
  pnpmPath: string;
  homeDir: string;
}

export function generateLaunchdPlist(options: LaunchdConfigOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yggdrasil.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${options.pnpmPath}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${options.appDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${path.join(options.logsDir, "yggdrasil.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(options.logsDir, "yggdrasil.err.log")}</string>
</dict>
</plist>
`;
}

export class LaunchdManager implements ServiceManager {
  private plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.yggdrasil.server.plist");

  async installService(paths: InstallPaths): Promise<void> {
    const pnpmRes = await runCommand("which", ["pnpm"]);
    const pnpmPath = pnpmRes.code === 0 ? pnpmRes.stdout.trim() : "/usr/local/bin/pnpm";

    const plist = generateLaunchdPlist({
      appDir: paths.appDir,
      logsDir: paths.logsDir,
      pnpmPath,
      homeDir: os.homedir(),
    });

    await fs.mkdir(path.dirname(this.plistPath), { recursive: true });
    await fs.writeFile(this.plistPath, plist, "utf8");

    await runCommand("launchctl", ["load", "-w", this.plistPath]);
  }

  async uninstallService(): Promise<void> {
    await runCommand("launchctl", ["unload", "-w", this.plistPath]);
    await fs.rm(this.plistPath, { force: true });
  }

  async start(): Promise<void> {
    await runCommand("launchctl", ["start", "com.yggdrasil.server"]);
  }

  async stop(): Promise<void> {
    await runCommand("launchctl", ["stop", "com.yggdrasil.server"]);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("launchctl", ["list", "com.yggdrasil.server"]);
    return { active: res.code === 0, details: res.stdout };
  }
}
```

```typescript
// src/cli/platform/windows.ts
import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

export function generateWindowsTaskCommand(): string {
  return `schtasks /Create /TN "Yggdrasil" /SC ONLOGON /TR "powershell.exe -NoProfile -WindowStyle Hidden -File \\"%USERPROFILE%\\.yggdrasil\\bin\\start-background.ps1\\"" /RL LIMITED /F`;
}

export class WindowsManager implements ServiceManager {
  async installService(paths: InstallPaths): Promise<void> {
    await fs.mkdir(paths.binDir, { recursive: true });
    const psScript = path.join(paths.binDir, "start-background.ps1");
    const scriptContent = `
Set-Location "$env:USERPROFILE\\.yggdrasil\\app"
$proc = Start-Process pnpm -ArgumentList "start" -RedirectStandardOutput "..\\data\\logs\\yggdrasil.log" -RedirectStandardError "..\\data\\logs\\yggdrasil.err.log" -PassThru -WindowStyle Hidden
$proc.Id | Out-File "..\\yggdrasil.pid" -Encoding ascii
`;
    await fs.writeFile(psScript, scriptContent.trim(), "utf8");
    await runCommand("cmd.exe", ["/c", generateWindowsTaskCommand()]);
  }

  async uninstallService(): Promise<void> {
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
    await runCommand("schtasks", ["/Delete", "/TN", "Yggdrasil", "/F"]);
  }

  async start(): Promise<void> {
    await runCommand("schtasks", ["/Run", "/TN", "Yggdrasil"]);
  }

  async stop(): Promise<void> {
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST"]);
    const active = res.stdout.includes("Running");
    return { active, details: res.stdout };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/__tests__/platform.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/platform/ src/cli/__tests__/platform.test.ts
git commit -m "feat(cli): add systemd, launchd, and windows service management implementations"
```

---

### Task 6: CLI Commands Orchestration (`install`, `update`, `uninstall`, `service`)

**Files:**
- Create: `src/cli/commands/install.ts`
- Create: `src/cli/commands/update.ts`
- Create: `src/cli/commands/uninstall.ts`
- Create: `src/cli/commands/service.ts`
- Create: `src/cli/index.ts`
- Test: `src/cli/__tests__/commands.test.ts`

**Interfaces:**
- Produces:
  - `installCommand(options: CliOptions): Promise<void>`
  - `updateCommand(options: CliOptions): Promise<void>`
  - `uninstallCommand(options: CliOptions): Promise<void>`
  - `serviceCommand(action: "start" | "stop" | "restart" | "status" | "logs", args?: string[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/__tests__/commands.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseCliArgs } from "../index";

describe("CLI Argument Parser and Command Dispatcher", () => {
  it("parses install options with defaults", () => {
    const parsed = parseCliArgs(["install"]);
    expect(parsed.command).toBe("install");
    expect(parsed.options.port).toBe(2302);
    expect(parsed.options.noService).toBe(false);
  });

  it("parses custom port and flags", () => {
    const parsed = parseCliArgs(["install", "--port", "8080", "--no-service", "--yes"]);
    expect(parsed.command).toBe("install");
    expect(parsed.options.port).toBe(8080);
    expect(parsed.options.noService).toBe(true);
    expect(parsed.options.yes).toBe(true);
  });

  it("parses uninstall purge flag", () => {
    const parsed = parseCliArgs(["uninstall", "--purge", "-y"]);
    expect(parsed.command).toBe("uninstall");
    expect(parsed.options.purge).toBe(true);
    expect(parsed.options.yes).toBe(true);
  });

  it("parses service lifecycle subcommands", () => {
    expect(parseCliArgs(["start"]).command).toBe("start");
    expect(parseCliArgs(["stop"]).command).toBe("stop");
    expect(parseCliArgs(["restart"]).command).toBe("restart");
    expect(parseCliArgs(["status"]).command).toBe("status");
    expect(parseCliArgs(["logs"]).command).toBe("logs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/commands.test.ts`  
Expected: FAIL with module not found for `../index`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/commands/install.ts
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths, ensureSymlink, ensureSecurePermissions, addPathToProfile } from "../utils/paths";
import { runCommand } from "../utils/exec";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

export async function installCommand(options: CliOptions): Promise<void> {
  const port = options.port ?? 2302;
  const paths = resolveInstallPaths(options.dir);

  console.log(`[Yggdrasil] Setting up installation at ${paths.baseDir}...`);
  await fs.mkdir(paths.logsDir, { recursive: true });
  await fs.mkdir(paths.skillsDir, { recursive: true });
  await fs.mkdir(paths.pluginsDir, { recursive: true });

  // Generate .env if absent
  try {
    await fs.access(paths.envFile);
  } catch {
    await fs.writeFile(paths.envFile, `PORT=${port}\nNODE_ENV=production\n`, "utf8");
  }

  // Secure secrets permissions
  await ensureSecurePermissions(path.join(paths.dataDir, "providers.secrets.env"));

  // Link app/data to canonical data
  const appData = path.join(paths.appDir, "data");
  await ensureSymlink(paths.dataDir, appData);

  // Install executable link to PATH
  if (process.platform !== "win32") {
    const localBin = path.join(process.env.HOME || "", ".local", "bin");
    await fs.mkdir(localBin, { recursive: true });
    await ensureSymlink(path.join(paths.appDir, "bin", "yggdrasil.mjs"), path.join(localBin, "yggdrasil"));
    await addPathToProfile(localBin);
  }

  if (!options.noService) {
    console.log(`[Yggdrasil] Registering background daemon service...`);
    const mgr = getServiceManager();
    await mgr.installService(paths, port);
    await mgr.start();

    console.log(`[Yggdrasil] Waiting for system health check on port ${port}...`);
    const ok = await waitForHealth(`http://localhost:${port}/api/health`, 30000);
    if (ok) {
      console.log(`[Yggdrasil] Installed and running successfully at http://localhost:${port}`);
    } else {
      console.warn(`[Yggdrasil] Service started but health check pending. Check logs at ${paths.logsDir}`);
    }
  }
}
```

```typescript
// src/cli/commands/update.ts
import path from "node:path";
import { resolveInstallPaths } from "../utils/paths";
import { backupDatabaseFiles, restoreDatabaseFiles } from "../utils/backup";
import { runCommand } from "../utils/exec";
import { waitForHealth } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

export async function updateCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);

  // 1. Safety check
  const statusRes = await runCommand("git", ["status", "--porcelain"], { cwd: paths.appDir });
  if (statusRes.stdout.trim().length > 0) {
    throw new Error("Working tree in app directory is dirty. Please commit or stash changes before updating.");
  }

  const prevShaRes = await runCommand("git", ["rev-parse", "HEAD"], { cwd: paths.appDir });
  const prevSha = prevShaRes.stdout.trim();
  const backupDest = path.join(paths.dataDir, "backups", `backup-${Date.now()}`);

  console.log(`[Yggdrasil] Stopping service for atomic update...`);
  const mgr = getServiceManager();
  await mgr.stop();

  console.log(`[Yggdrasil] Backing up SQLite database...`);
  await backupDatabaseFiles(paths.dataDir, backupDest);

  try {
    console.log(`[Yggdrasil] Pulling latest code from main branch...`);
    const fetchRes = await runCommand("git", ["fetch", "origin", "main"], { cwd: paths.appDir });
    if (fetchRes.code !== 0) throw new Error(fetchRes.stderr);

    const checkoutRes = await runCommand("git", ["checkout", "main"], { cwd: paths.appDir });
    if (checkoutRes.code !== 0) throw new Error(checkoutRes.stderr);

    const mergeRes = await runCommand("git", ["merge", "--ff-only", "origin/main"], { cwd: paths.appDir });
    if (mergeRes.code !== 0) throw new Error(mergeRes.stderr);

    console.log(`[Yggdrasil] Installing dependencies & building...`);
    const installRes = await runCommand("pnpm", ["install"], { cwd: paths.appDir });
    if (installRes.code !== 0) throw new Error(installRes.stderr);

    const buildRes = await runCommand("pnpm", ["build"], { cwd: paths.appDir });
    if (buildRes.code !== 0) throw new Error(buildRes.stderr);
  } catch (err: unknown) {
    console.error(`[Yggdrasil] Update failed! Rolling back to ${prevSha}...`, err);
    await runCommand("git", ["reset", "--hard", prevSha], { cwd: paths.appDir });
    await restoreDatabaseFiles(backupDest, paths.dataDir);
    await mgr.start();
    throw err;
  }

  await mgr.start();
  const ok = await waitForHealth("http://localhost:2302/api/health", 30000);
  console.log(ok ? "[Yggdrasil] Successfully updated and verified healthy!" : "[Yggdrasil] Update complete; verifying health...");
}
```

```typescript
// src/cli/commands/uninstall.ts
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths } from "../utils/paths";
import { waitForProcessExit } from "../utils/health";
import { getServiceManager } from "../platform";
import type { CliOptions } from "../types";

export async function uninstallCommand(options: CliOptions): Promise<void> {
  const paths = resolveInstallPaths(options.dir);

  console.log(`[Yggdrasil] Stopping and removing service...`);
  const mgr = getServiceManager();
  await mgr.uninstallService();

  // Wait for process exit if PID exists
  try {
    const pidStr = await fs.readFile(paths.pidFile, "utf8");
    const pid = parseInt(pidStr.trim(), 10);
    if (!isNaN(pid)) {
      await waitForProcessExit(pid, 10000);
    }
  } catch {
    // PID file not present or unreadable
  }

  // Remove symlinks
  if (process.platform !== "win32") {
    const symlink = path.join(process.env.HOME || "", ".local", "bin", "yggdrasil");
    await fs.rm(symlink, { force: true });
  }

  if (options.purge) {
    console.log(`[Yggdrasil] Purging entire directory ${paths.baseDir}...`);
    await fs.rm(paths.baseDir, { recursive: true, force: true });
  } else {
    console.log(`[Yggdrasil] Preserving data in ${paths.dataDir}; removing app binaries...`);
    await fs.rm(paths.appDir, { recursive: true, force: true });
  }

  console.log(`[Yggdrasil] Uninstallation completed.`);
}
```

```typescript
// src/cli/commands/service.ts
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInstallPaths } from "../utils/paths";
import { getServiceManager } from "../platform";

export async function serviceCommand(action: "start" | "stop" | "restart" | "status" | "logs", args: string[] = []): Promise<void> {
  const mgr = getServiceManager();
  const paths = resolveInstallPaths();

  if (action === "start") {
    await mgr.start();
    console.log("[Yggdrasil] Service started.");
  } else if (action === "stop") {
    await mgr.stop();
    console.log("[Yggdrasil] Service stopped.");
  } else if (action === "restart") {
    await mgr.restart();
    console.log("[Yggdrasil] Service restarted.");
  } else if (action === "status") {
    const stat = await mgr.status();
    console.log(`[Yggdrasil] Service status: ${stat.active ? "ACTIVE" : "INACTIVE"}`);
    if (stat.details) console.log(stat.details);
  } else if (action === "logs") {
    const logPath = path.join(paths.logsDir, "yggdrasil.log");
    try {
      const content = await fs.readFile(logPath, "utf8");
      const lines = content.trim().split("\n");
      const tail = lines.slice(-50).join("\n");
      console.log(tail || "(Log file empty)");
    } catch {
      console.log(`No log file found at ${logPath}`);
    }
  }
}
```

```typescript
// src/cli/index.ts
import type { CliOptions } from "./types";
import { installCommand } from "./commands/install";
import { updateCommand } from "./commands/update";
import { uninstallCommand } from "./commands/uninstall";
import { serviceCommand } from "./commands/service";

export interface ParsedArgs {
  command: string;
  options: CliOptions;
  extraArgs: string[];
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const command = argv[0] || "status";
  const options: CliOptions = {
    port: 2302,
    noService: false,
    yes: false,
    purge: false,
  };
  const extraArgs: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) {
      options.port = parseInt(argv[++i], 10);
    } else if (arg === "--dir" && argv[i + 1]) {
      options.dir = argv[++i];
    } else if (arg === "--no-service") {
      options.noService = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--purge") {
      options.purge = true;
    } else {
      extraArgs.push(arg);
    }
  }

  return { command, options, extraArgs };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, options, extraArgs } = parseCliArgs(argv);

  switch (command) {
    case "install":
      await installCommand(options);
      break;
    case "update":
      await updateCommand(options);
      break;
    case "uninstall":
      await uninstallCommand(options);
      break;
    case "start":
    case "stop":
    case "restart":
    case "status":
    case "logs":
      await serviceCommand(command, extraArgs);
      break;
    case "--help":
    case "-h":
    case "help":
      console.log(`Yggdrasil System CLI
Commands:
  install     Install Yggdrasil and set up background service
  update      Safely pull, backup, and rebuild Yggdrasil
  uninstall   Remove service and application (optionally --purge data)
  start       Start background service
  stop        Stop background service
  restart     Restart background service
  status      Check background service status
  logs        View recent application logs
`);
      break;
    default:
      console.error(`Unknown command: ${command}. Use "yggdrasil help" for usage.`);
      process.exit(1);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/__tests__/commands.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/ src/cli/index.ts src/cli/__tests__/commands.test.ts
git commit -m "feat(cli): add install, update, uninstall, and service CLI command handlers"
```

---

### Task 7: CLI Executable Wrappers (`bin/yggdrasil.mjs` & `package.json`)

**Files:**
- Create: `bin/yggdrasil.mjs`
- Create: `bin/yggdrasil.cmd`
- Modify: `package.json` (add `"bin": { "yggdrasil": "./bin/yggdrasil.mjs" }`)
- Test: `src/cli/__tests__/bin.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/__tests__/bin.test.ts
import { describe, it, expect } from "vitest";
import { runCommand } from "../utils/exec";
import path from "node:path";

describe("CLI Executable Wrapper", () => {
  const binPath = path.resolve(__dirname, "../../../bin/yggdrasil.mjs");

  it("prints help when executed with --help", async () => {
    const res = await runCommand(process.execPath, [binPath, "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Yggdrasil System CLI");
    expect(res.stdout).toContain("install");
    expect(res.stdout).toContain("update");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/bin.test.ts`  
Expected: FAIL with executable not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
#!/usr/bin/env node
// bin/yggdrasil.mjs
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(__dirname, "../src/cli/index.ts");

// Register tsx or load compiled/direct ts module
try {
  const { main } = await import(cliEntry);
  await main();
} catch (err) {
  console.error("[Yggdrasil CLI Error]", err);
  process.exit(1);
}
```

```cmd
@REM bin/yggdrasil.cmd
@echo off
node "%~dp0\yggdrasil.mjs" %*
```

Update `package.json`:
```json
"bin": {
  "yggdrasil": "./bin/yggdrasil.mjs"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/__tests__/bin.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/ package.json src/cli/__tests__/bin.test.ts
git commit -m "feat(cli): add bin executable wrappers and declare bin in package.json"
```

---

### Task 8: Verified Bootstrap Scripts (`install.sh` & `install.ps1`)

**Files:**
- Create: `install.sh`
- Create: `install.ps1`
- Test: `src/cli/__tests__/bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/__tests__/bootstrap.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

describe("Bootstrap Installer Scripts", () => {
  const root = path.resolve(__dirname, "../../../");

  it("install.sh exists, is executable, and contains sha256 checksum check", async () => {
    const shPath = path.join(root, "install.sh");
    const content = await fs.readFile(shPath, "utf8");
    expect(content).toContain("sha256sum");
    expect(content).toContain("yggdrasil");
  });

  it("install.ps1 exists and contains SHA256 Get-FileHash check", async () => {
    const ps1Path = path.join(root, "install.ps1");
    const content = await fs.readFile(ps1Path, "utf8");
    expect(content).toContain("Get-FileHash");
    expect(content).toContain("SHA256");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/__tests__/bootstrap.test.ts`  
Expected: FAIL with file not found.

- [ ] **Step 3: Write minimal implementation**

```bash
#!/usr/bin/env bash
# install.sh - POSIX Verified Bootstrap Installer for Yggdrasil
set -euo pipefail

DEFAULT_DIR="$HOME/.yggdrasil"
REPO_URL="https://github.com/anjasta-tarigan/yggdrasil.git"
TARGET_DIR="${1:-$DEFAULT_DIR}"

echo "[Yggdrasil] Checking system prerequisites..."
command -v git >/dev/null 2>&1 || { echo "Git is required but not installed." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js (>=20.9.0) is required but not installed." >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || {
  echo "[Yggdrasil] pnpm not found. Attempting corepack enable pnpm..."
  corepack enable pnpm || { echo "Failed to enable pnpm via corepack. Please install pnpm." >&2; exit 1; }
}

mkdir -p "$TARGET_DIR"
APP_DIR="$TARGET_DIR/app"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[Yggdrasil] Cloning repository to $APP_DIR..."
  git clone --branch main "$REPO_URL" "$APP_DIR"
else
  echo "[Yggdrasil] Existing repository detected at $APP_DIR."
fi

cd "$APP_DIR"
pnpm install --frozen-lockfile
pnpm build

echo "[Yggdrasil] Running CLI installer..."
node bin/yggdrasil.mjs install --dir "$TARGET_DIR" "$@"
```

```powershell
# install.ps1 - Windows PowerShell Bootstrap Installer for Yggdrasil
param (
    [string]$TargetDir = "$env:USERPROFILE\.yggdrasil"
)

$ErrorActionPreference = "Stop"

Write-Host "[Yggdrasil] Checking system prerequisites..."
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is required but not installed."
    exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js (>=20.9.0) is required but not installed."
    exit 1
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "[Yggdrasil] Enabling pnpm via corepack..."
    corepack enable pnpm
}

$appDir = "$TargetDir\app"
if (-not (Test-Path "$appDir\.git")) {
    Write-Host "[Yggdrasil] Cloning repository to $appDir..."
    git clone --branch main "https://github.com/anjasta-tarigan/yggdrasil.git" "$appDir"
}

Set-Location "$appDir"
pnpm install --frozen-lockfile
pnpm build

node bin\yggdrasil.mjs install --dir "$TargetDir"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli/__tests__/bootstrap.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
chmod +x install.sh
git add install.sh install.ps1 src/cli/__tests__/bootstrap.test.ts
git commit -m "feat(cli): add POSIX and Windows bootstrap installer scripts"
```

---

### Task 9: Full Suite Regression Verification & Documentation

**Files:**
- Modify: `README.md` (add CLI installation and management documentation)
- Test: All touched CLI & API suites

- [ ] **Step 1: Update README.md with CLI installation guide**

Document:
```markdown
## Quick Start & CLI Installation

### Linux & macOS
```bash
curl -fsSL https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.sh | bash
```

### Windows
```powershell
irm https://raw.githubusercontent.com/anjasta-tarigan/yggdrasil/main/install.ps1 | iex
```

### Management Commands
```bash
yggdrasil status    # Check service health and port (default: 2302)
yggdrasil logs      # Tail system logs
yggdrasil update    # Atomic update with automatic WAL backup & rollback
yggdrasil restart   # Restart background daemon
yggdrasil uninstall # Remove service and application
```
```

- [ ] **Step 2: Run all CLI and touched unit tests**

Run: `pnpm vitest run src/cli/__tests__/ src/app/api/__tests__/health-api.test.ts`  
Expected: PASS with 0 failures.

- [ ] **Step 3: Run TypeScript type-check and linter**

Run: `pnpm tsc --noEmit`  
Run: `pnpm eslint`  
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(cli): add CLI installation and lifecycle management documentation to README"
```
