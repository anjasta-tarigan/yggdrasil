# Architecture & Design Specification: Advanced Built-in Tools (`file_operations`, `notify_user`, `host_info`)

**Date:** 2026-09-07  
**Status:** Approved for Implementation (Post-Deep-Review Revision)  
**Branch:** `feat/builtin-tools`  
**Target Modules:** `src/lib/ai/tools/`  

---

## 1. Executive Summary & Purpose

This specification defines the architecture, schema, security boundaries, and execution models for three high-performance built-in tools in Yggdrasil:
1. **`file_operations`**: A unified, high-level filesystem tool offering structured actions (`list`, `find`, `grep`, `jump`, `read`, `write`, `edit`). It uses native argument arrays (`shell: false`) to completely prevent command injection, automatically probes for modern high-speed CLI utilities (`eza`, `fd`, `rg`, `zoxide`), verifies boundary containment on all paths (including `zoxide` outputs), sniffs binary files, guards against accidental overwrites with rolling `.bak` snapshots, and gracefully falls back to secure Node.js primitives.
2. **`notify_user`**: A multi-channel alert delivery mechanism triggering in-app toast feedback, native Web Audio chimes, and OS-level Web Notifications, equipped with rate limiting and deduplication.
3. **`host_info`**: A read-only diagnostic tool providing the model with environment awareness (OS, architecture, resources, and installed tool availability).

---

## 2. Threat Model & Security Invariants

Because tool arguments (`path`, `query`, `pattern`, `content`) are produced by an LLM that may be steered by external or untrusted text (indirect prompt injection via web pages, files, or user attachments):
1. **Zero Shell Interpolation Invariant (OWASP A03):** Under no circumstances shall arguments be passed into a shell interpreter (`exec()` or `{ shell: true }` are strictly forbidden). All subprocess execution uses `spawn` / `execFile` with explicit argument arrays. Piped commands (e.g. `find | head`) are banned; truncation occurs in Node memory.
2. **Strict Workspace Boundary & Traversal Assertion (Rule 06 & OWASP A01):**
   - Every input path and every output path (including paths resolved via `zoxide query`) must be resolved to a canonical path via `path.resolve` and checked against the workspace root (`process.cwd()` or designated `data/workspace`).
   - If a resolved path escapes the workspace root, the operation aborts with a security violation error.
3. **Sensitive File & Credential Guardrail (OWASP A02/A05):**
   - Regardless of whether they sit inside the workspace, accesses to files matching sensitive patterns are blocked:
     - Keys & Certificates: `*.pem`, `*.key`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `*.p12`, `*.keystore`
     - Cloud & Service Tokens: `.env*`, `.aws/credentials`, `.aws/config`, `.npmrc`, `.pypirc`, `.netrc`, `.docker/config.json`
     - Version Control & OS: `.git/config`, `/etc/shadow`, `/etc/passwd`
4. **Destructive Overwrite Protection (Rule 16 / Rule 17):**
   - `write`: If the target file already exists, a backup copy `<path>.bak` is created atomically before writing. Max write payload is capped at 2MB.
   - `edit`: Requires `oldString` to match exactly once in the file (fail fast on 0 or >1 matches) to prevent unintended collateral edits.
5. **Binary Content Sniffing:**
   - `read`: Checks the first 512 bytes for null bytes (`\0`). If detected, returns `{ path, isBinary: true, bytes: fileSize, message: "Binary file, not displayed as text" }` rather than dumping corrupt tokens into the model context.
6. **Rate Limiting (Rule 18):**
   - `notify_user` enforces a rate limit (maximum 5 notifications per 60 seconds per chat session) and suppresses identical consecutive notifications.

---

## 3. Directory & Module Structure

```
src/lib/ai/tools/
├── files.ts                 # Unified file_operations tool definition & dispatcher
├── file-capabilities.ts     # In-memory cached CLI tool availability detector (fd, rg, eza, zoxide)
├── notify.ts                # notify_user tool definition, rate limiter & event dispatch
├── system.ts                # host_info diagnostic tool definition
├── index.ts                 # Registry entrypoint exporting builtinTools
└── __tests__/
    ├── files.test.ts        # Unit & security tests for file_operations (command injection, path escape, zoxide boundary)
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
   - Execution: If `eza` is available, spawns `['eza', '--tree', '--level=' + depth, '--color=never', ...(showHidden ? ['-a'] : []), resolvedPath]`.
   - Fallback: Native recursive Node.js `fs.readdir` tree formatter bounded by `depth`.
2. **`find`**:
   - Inputs: `pattern` (string), `path` (default `.`).
   - Execution: If `fd` is available, spawns `['fd', '--color=never', '--max-results', '50', pattern, resolvedPath]`.
   - Fallback: Spawns `['find', resolvedPath, '-name', '*' + pattern + '*']` (argument array, NO shell pipe) and truncates output lines to 50 in Node.
3. **`grep`**:
   - Inputs: `query` (string), `path` (default `.`), `caseSensitive` (default false).
   - Execution: If `rg` is available, spawns `['rg', '--no-heading', '--line-number', '--color=never', '--max-count', '50', ...(caseSensitive ? [] : ['-i']), query, resolvedPath]`.
   - Fallback: Spawns `['grep', '-rnI', '--max-count=50', ...(caseSensitive ? [] : ['-i']), query, resolvedPath]`.
4. **`jump`**:
   - Inputs: `query` (string).
   - Execution: If `zoxide` is available, spawns `['zoxide', 'query', query]`.
   - **Critical Guard**: The stdout path from zoxide is immediately normalized with `path.resolve` and tested against the workspace boundary. If it points outside the workspace root, returns `{ error: "Resolved directory escapes workspace boundary: " + targetPath }`.
   - Fallback: Scans first 2 levels of directories matching `query` prefix within workspace.
5. **`read`**:
   - Inputs: `path` (string), `offset` (optional number, 1-based), `limit` (optional number).
   - Execution:
     - Asserts path containment and non-sensitive status.
     - Performs binary sniff on first 512 bytes. If binary, returns `{ isBinary: true, bytes, path }`.
     - Formats text with line numbers (`cat -n` style), truncated at 50KB / 1000 lines.
6. **`write`**:
   - Inputs: `path` (string), `content` (string, max 2MB).
   - Execution:
     - Asserts path containment and non-sensitive status.
     - If file exists, creates backup snapshot `<path>.bak.<timestamp>`.
     - Creates parent directories recursively and writes file.
7. **`edit`**:
   - Inputs: `path` (string), `oldString` (string), `newString` (string).
   - Execution:
     - Asserts path containment and non-sensitive status.
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
- In-memory token bucket or sliding window: max 5 notifications per 60 seconds per chat. If exceeded, returns `{ delivered: false, reason: "Rate limit exceeded (max 5/min)" }`.
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
   - Command injection attacks: Passes malicious query strings (e.g. `'; rm -rf / ;'`, `$(whoami)`, `| cat /etc/passwd`) to `find`, `grep`, `jump` and verifies they are treated as inert literal text.
   - Path traversal attacks: Tests `../../etc/passwd`, `~/.ssh/id_rsa`, and symlink bypasses.
   - Zoxide boundary containment: Mocks zoxide returning `/etc` or `/home/user/.ssh` and verifies `jump` strictly rejects it.
   - Sensitive file denylist: Tests access rejection for `.env`, `id_rsa`, `.aws/credentials`, `server.pem`.
   - Binary sniff test: Asserts that reading a file with null bytes returns `isBinary: true` without dumping raw bytes.
   - Overwrite backup test: Tests that writing to an existing file creates `<path>.bak.<timestamp>`.
2. **Notification Tests (`notify.test.ts`)**:
   - Tests successful dispatch, rate limiting (burst of 6 returns `delivered: false` on the 6th), and deduplication of rapid identical messages.
3. **System Tool Tests (`system.test.ts`)**:
   - Tests `host_info` output shape and caching of tool availability.
4. **Integration with `builtinTools` (`index.ts`)**:
   - Verifies `file_operations`, `notify_user`, and `host_info` are exported in `builtinTools` and present in `chatTools`.
