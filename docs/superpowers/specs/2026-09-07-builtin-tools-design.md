# Architecture & Design Specification: Advanced Built-in Tools (`file_operations`, `notify_user`, `host_info`)

**Date:** 2026-09-07  
**Status:** Approved for Implementation (Post-Re-Review Revision 2)  
**Branch:** `feat/builtin-tools`  
**Target Modules:** `src/lib/ai/tools/`  

---

## 1. Executive Summary & Purpose

This specification defines the architecture, schema, security boundaries, and execution models for three high-performance built-in tools in Yggdrasil:
1. **`file_operations`**: A unified, high-level filesystem tool offering structured actions (`list`, `find`, `grep`, `jump`, `read`, `write`, `edit`). It uses native argument arrays (`shell: false`) to completely prevent command injection, automatically probes for modern high-speed CLI utilities (`eza`, `fd`, `rg`, `zoxide`), verifies physical boundary containment using `fs.realpath` to block single, chained, and dangling symlink escapes, sniffs binary files, guards against accidental overwrites with rolling `.bak` snapshots, enforces sensitive file/directory exclusions across search and grep, and gracefully falls back to secure Node.js primitives.
2. **`notify_user`**: A multi-channel alert delivery mechanism triggering in-app toast feedback, native Web Audio chimes, and OS-level Web Notifications, equipped with rate limiting and deduplication.
3. **`host_info`**: A read-only diagnostic tool providing the model with environment awareness (OS, architecture, resources, and installed tool availability) with a 5-minute cache TTL.

---

## 2. Threat Model & Security Invariants

Because tool arguments (`path`, `query`, `pattern`, `content`) are produced by an LLM that may be steered by external or untrusted text (indirect prompt injection via web pages, files, or user attachments):

### 2.1 Zero Shell Interpolation Invariant (OWASP A03)
Under no circumstances shall arguments be passed into a shell interpreter (`exec()` or `{ shell: true }` are strictly forbidden). All subprocess execution uses `spawn` / `execFile` with explicit argument arrays. Piped commands (e.g. `find | head`) are banned; truncation occurs in Node memory.

### 2.2 Canonical Physical Boundary Assertion (`fs.realpath` & Symlink Defenses)
String normalization via `path.resolve()` alone is insufficient because it does not resolve symbolic links, enabling directory traversal vulnerabilities via symlinks pointing outside the workspace (as seen in Backstage CVE-2026-24047, DesktopCommanderMCP, and fast-filesystem-mcp).
- **Two-Step Canonicalization Algorithm (`assertSafePath`)**:
  1. Calculate normalized absolute path: `target = path.resolve(workspaceRoot, inputPath)`.
  2. Compute canonical physical location:
     - **If file/path exists:** Run `canonical = await fs.realpath(target)`.
     - **If file does not exist yet (e.g. `write` target):** Ascend parent directories to find the nearest existing ancestor, compute `canonicalParent = await fs.realpath(existingParent)`, and assert `canonicalParent.startsWith(canonicalWorkspaceRoot)`. Additionally, verify `target` string does not cross any intermediate symlinks that resolve outside the root.
  3. Assert: `canonical.startsWith(canonicalWorkspaceRoot + path.sep) || canonical === canonicalWorkspaceRoot`. If false, abort immediately with `Security Violation: Path escapes workspace root: ${inputPath}`.
- **Coverage:** This defends against direct traversal (`../../`), single-hop symlink escapes, multi-hop symlink chains (`linkA -> linkB -> /etc`), and dangling symlinks created prior to write.
- **`zoxide` Guard:** The path returned by `zoxide query` must pass this exact `assertSafePath` algorithm before any operation or output is produced.

### 2.3 Comprehensive Sensitive File & Directory Guardrail
Access to sensitive credentials and configuration files is strictly forbidden across all operations (`read`, `write`, `edit`, `find`, `grep`):
- **Matching Semantics:**
  - Basename globs: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.crt`
  - Basename prefix/exact matches: `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, `.env*`, `.npmrc`, `.pypirc`, `.netrc`
  - Relative path patterns: `.aws/*`, `.docker/config.json`, `.git/config`, `.ssh/*`, `/etc/shadow`, `/etc/passwd`
- **Default Noise & Performance Exclusions:**
  - In addition to secrets, search commands (`find`, `grep`, `list`) automatically exclude heavy dependencies and build outputs by default: `node_modules`, `.git`, `.next`, `dist`, `build`, `.turbo`, `.cache`.

### 2.4 Destructive Overwrite Protection (Rule 16 / Rule 17)
- `write`: If the target file already exists, a backup copy `<path>.bak.<timestamp>` is created atomically before writing. Max write payload is capped at 2MB.
- `edit`: Requires `oldString` to match exactly once in the file (fail fast on 0 or >1 matches) to prevent unintended collateral edits.

### 2.5 Binary Content Sniffing
- `read`: Checks the first 512 bytes for null bytes (`\0`). If detected, returns `{ path, isBinary: true, bytes: fileSize, message: "Binary file, not displayed as text" }` rather than dumping corrupt tokens into the model context.

### 2.6 Resource Discipline & Rate Limiting (Rule 18)
- `notify_user`: Enforces a sliding window limit of maximum 5 notifications per 60 seconds per chat session, and suppresses identical consecutive notifications within a 10-second window.
- `host_info`: In-memory tool capability cache has a 5-minute TTL to prevent redundant spawning of `which` subprocesses.

---

## 3. Directory & Module Structure

```
src/lib/ai/tools/
├── files.ts                 # Unified file_operations tool definition & dispatcher
├── file-security.ts         # assertSafePath, realpath verification, sensitive file matchers
├── file-capabilities.ts     # In-memory cached CLI tool availability detector (fd, rg, eza, zoxide)
├── notify.ts                # notify_user tool definition, rate limiter & event dispatch
├── system.ts                # host_info diagnostic tool definition
├── index.ts                 # Registry entrypoint exporting builtinTools
└── __tests__/
    ├── files.test.ts        # Unit & security tests for file_operations (command injection, realpath symlink escape, zoxide boundary)
    ├── notify.test.ts       # Schema, rate-limiting & execution tests for notify_user
    └── system.test.ts       # Host diagnostic & discovery tests
```

---

## 4. Detailed Tool Specifications

### 4.1 `file_operations`
Exported from `src/lib/ai/tools/files.ts`.

#### Action Discriminated Union:
1. **`list`**:
   - Inputs: `path` (default `.`), `depth` (1-5, default 2), `showHidden` (boolean, default false).
   - Execution:
     - Validates directory path with `assertSafePath`.
     - If `eza` is available, spawns `['eza', '--tree', '--level=' + depth, '--color=never', '--ignore-glob', 'node_modules|.git|.next|dist', ...(showHidden ? ['-a'] : []), resolvedPath]` with `shell: false`.
     - Fallback: Native recursive Node.js `fs.readdir` tree formatter filtering default exclusions and bounded by `depth`.
2. **`find`**:
   - Inputs: `pattern` (string), `path` (default `.`).
   - Execution:
     - Validates search root with `assertSafePath`.
     - If `fd` is available, spawns `['fd', '--color=never', '--max-results', '50', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', '.next', '--exclude', '.env*', '--exclude', '*.pem', '--exclude', '*.key', pattern, resolvedPath]` with `shell: false`.
     - Fallback: Spawns `['find', resolvedPath, '-name', '*' + pattern + '*']` (argument array, NO shell pipe), post-filters results in Node to drop sensitive matches and default exclusions, and truncates to 50 items.
3. **`grep`**:
   - Inputs: `query` (string), `path` (default `.`), `caseSensitive` (default false).
   - Execution:
     - Validates search root with `assertSafePath`.
     - If `rg` is available, spawns `['rg', '--no-heading', '--line-number', '--color=never', '--max-count', '50', '--glob', '!node_modules', '--glob', '!.git', '--glob', '!.next', '--glob', '!.env*', '--glob', '!*.pem', '--glob', '!*.key', '--glob', '!id_*', ...(caseSensitive ? [] : ['-i']), query, resolvedPath]` with `shell: false`.
     - Fallback: Spawns `['grep', '-rnI', '--max-count=50', ...(caseSensitive ? [] : ['-i']), query, resolvedPath]` with `shell: false`, post-filters out sensitive matches, and caps output lines at 50.
4. **`jump`**:
   - Inputs: `query` (string).
   - Execution:
     - If `zoxide` is available, spawns `['zoxide', 'query', query]` with `shell: false`.
     - **Critical Guard**: The raw stdout path from zoxide is immediately evaluated with `assertSafePath(stdout.trim())`. If it points to or symlinks outside the workspace root, returns `{ error: "Resolved directory escapes workspace boundary: " + targetPath }`.
     - Fallback: Scans first 2 levels of non-excluded directories matching `query` prefix within workspace.
5. **`read`**:
   - Inputs: `path` (string), `offset` (optional number, 1-based), `limit` (optional number).
   - Execution:
     - Runs `assertSafePath(path)` and checks `isSensitiveFile(path)`.
     - Performs binary sniff on first 512 bytes for `\0`. If binary, returns `{ isBinary: true, bytes, path }`.
     - Formats text with line numbers (`cat -n` style), truncated at 50KB / 1000 lines.
6. **`write`**:
   - Inputs: `path` (string), `content` (string, max 2MB).
   - Execution:
     - Runs `assertSafePath(path)` and checks `isSensitiveFile(path)`.
     - If file already exists, creates backup snapshot `<path>.bak.<timestamp>`.
     - Creates parent directories recursively and writes file.
7. **`edit`**:
   - Inputs: `path` (string), `oldString` (string), `newString` (string).
   - Execution:
     - Runs `assertSafePath(path)` and checks `isSensitiveFile(path)`.
     - Reads file, verifies `oldString` exists exactly once. Throws error if 0 or >1 matches.
     - Replaces string and writes back atomically.

---

### 4.2 `notify_user`
Exported from `src/lib/ai/tools/notify.ts`.

#### Schema:
```typescript
z.object({
  title: z.string().min(1).max(100).describe("Short, informative notification title"),
  message: z.string().min(1).max(500).describe("Descriptive notification content"),
  level: z.enum(["info", "success", "warning", "urgent"]).default("info"),
  sound: z.boolean().default(true),
})
```

#### Rate Limiting & Execution:
- In-memory sliding window: max 5 notifications per 60 seconds per chat. If exceeded, returns `{ delivered: false, reason: "Rate limit exceeded (max 5/min)" }`.
- Deduplication: If `title` and `message` match the previous notification within 10 seconds, skips re-notifying and returns `{ delivered: false, reason: "Duplicate suppressed" }`.
- Client UI:
  - Dispatches browser `new Notification(title, { body: message })` if permission granted.
  - Plays Web Audio synth chime if `sound: true`.

---

### 4.3 `host_info`
Exported from `src/lib/ai/tools/system.ts`.

#### Schema & Behavior:
- Accepts empty object `{}`.
- Returns:
  ```typescript
  {
    os: { platform: string, release: string, arch: string },
    resources: { totalMemMb: number, freeMemMb: number, cpus: number, uptimeHours: number },
    tools: {
      hasEza: boolean,
      hasFd: boolean,
      hasRipgrep: boolean,
      hasZoxide: boolean,
      hasFzf: boolean
    }
  }
  ```
- Cached tool detection: Probes `which eza`, `which fd`, `which rg`, `which zoxide`, `which fzf` once and caches results with a 5-minute TTL.

---

## 5. Testing & Verification Matrix

1. **Security & Injection Tests (`files.test.ts`)**:
   - **Command injection attacks:** Passes malicious query strings (e.g. `'; rm -rf / ;'`, `$(whoami)`, `| cat /etc/passwd`) to `find`, `grep`, `jump` and verifies they are treated as inert literal text.
   - **Symlink escapes:**
     - Tests direct symlink escape (`link -> /etc/passwd`).
     - Tests chained symlink escape (`linkA -> linkB -> /etc/passwd`).
     - Tests dangling symlink created prior to `write` attempting to point outside workspace root.
   - **Zoxide boundary containment:** Mocks zoxide returning `/etc` or `/home/user/.ssh` and verifies `jump` strictly rejects it.
   - **Sensitive file filter in `find` & `grep`:** Asserts that neither `find` nor `grep` return hits inside `.env*`, `id_rsa`, or `server.pem`.
   - **Binary sniff test:** Asserts that reading a file with null bytes returns `isBinary: true` without dumping raw bytes.
   - **Overwrite backup test:** Tests that writing to an existing file creates `<path>.bak.<timestamp>`.
2. **Notification Tests (`notify.test.ts`)**:
   - Tests successful dispatch, rate limiting (burst of 6 returns `delivered: false` on the 6th), and deduplication of rapid identical messages.
3. **System Tool Tests (`system.test.ts`)**:
   - Tests `host_info` output shape and caching of tool availability.
4. **Integration with `builtinTools` (`index.ts`)**:
   - Verifies `file_operations`, `notify_user`, and `host_info` are exported in `builtinTools` and present in `chatTools`.
