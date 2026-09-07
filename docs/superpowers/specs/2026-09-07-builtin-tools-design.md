# Architecture & Design Specification: Advanced Built-in Tools (`file_operations`, `notify_user`, `host_info`)

**Date:** 2026-09-07  
**Status:** Approved for Implementation  
**Branch:** `feat/builtin-tools`  
**Target Modules:** `src/lib/ai/tools/`  

---

## 1. Executive Summary & Purpose

This specification defines the architecture, schema, security boundaries, and execution models for three high-performance built-in tools in Yggdrasil:
1. **`file_operations`**: A unified, high-level filesystem tool offering structured actions (`list`, `find`, `grep`, `jump`, `read`, `write`, `edit`). It automatically probes for modern high-speed CLI utilities (`eza`, `fd`, `rg`, `zoxide`, `fzf`) and seamlessly falls back to standard POSIX/Node.js primitives when they are absent.
2. **`notify_user`**: A multi-channel alert delivery mechanism triggering in-app toast feedback, native Web Audio chimes, and OS-level Web Notifications.
3. **`host_info`**: A read-only diagnostic tool providing the model with environment awareness (OS, architecture, resources, and installed tool availability).

---

## 2. Directory & Module Structure

```
src/lib/ai/tools/
├── files.ts                 # Unified file_operations tool definition & dispatcher
├── file-capabilities.ts     # In-memory cached CLI tool availability detector (fd, rg, eza, etc.)
├── notify.ts                # notify_user tool definition & event dispatch
├── system.ts                # host_info diagnostic tool definition
├── index.ts                 # Registry entrypoint exporting builtinTools
└── __tests__/
    ├── files.test.ts        # Unit & security boundary tests for file_operations
    ├── notify.test.ts       # Schema and execution tests for notify_user
    └── system.test.ts       # Host diagnostic & discovery tests
```

---

## 3. Tool Specifications

### 3.1 `file_operations`
Exported from `src/lib/ai/tools/files.ts`.

#### Action Discriminated Union:
1. **`list`**:
   - Inputs: `path` (default `.`), `depth` (1-5, default 2), `showHidden` (boolean).
   - Execution: If `eza` is available, runs `eza --tree --level=<depth> --color=never`. Fallback: Node.js recursive directory lister with formatting.
2. **`find`**:
   - Inputs: `pattern` (glob or name), `path` (default `.`).
   - Execution: If `fd` is available, runs `fd --color=never <pattern> <path> --max-results 50`. Fallback: `find <path> -name "*pattern*" | head -n 50`.
3. **`grep`**:
   - Inputs: `query` (text or regex), `path` (default `.`), `caseSensitive` (default false).
   - Execution: If `rg` is available, runs `rg --no-heading --line-number --color=never --max-count 50 <query> <path>`. Fallback: `grep -rnI --max-count=50 <query> <path>`.
4. **`jump`**:
   - Inputs: `query` (target directory keyword).
   - Execution: If `zoxide` is available, runs `zoxide query <query>`. Fallback: prefix match against known directory tree.
5. **`read`**:
   - Inputs: `path`, optional `offset` (1-based line), optional `limit` (line count).
   - Execution: Reads file with line numbers (e.g. `cat -n` format), truncated at 50KB / 1000 lines.
6. **`write`**:
   - Inputs: `path`, `content`.
   - Execution: Creates parent directories automatically and writes content atomically.
7. **`edit`**:
   - Inputs: `path`, `oldString`, `newString`.
   - Execution: Surgical string replacement. Requires `oldString` to be present exactly once; throws a descriptive error if missing or ambiguous.

#### Security & Path Traversal Guards:
- Anchored to project workspace directory (`process.cwd()` or designated workspace).
- Resolves paths with `path.resolve` and `fs.realpath`.
- Rejects escaping out of authorized roots or targeting system credentials (`~/.ssh`, `/etc/shadow`, `.env*` master secrets).

### 3.2 `notify_user`
Exported from `src/lib/ai/tools/notify.ts`.

#### Schema:
```typescript
z.object({
  title: z.string().min(1).max(100),
  message: z.string().min(1).max(500),
  level: z.enum(["info", "success", "warning", "urgent"]).default("info"),
  sound: z.boolean().default(true),
})
```

#### Client & Server Behavior:
- **Server Execution**: Emits structured log and returns `{ delivered: true, timestamp: Date.now(), level, title }`.
- **Client Execution / UI**:
  - Web Audio tone: Plays non-blocking synthesize chime (frequencies matched to severity: Info 440Hz, Success 523Hz/659Hz arpeggio, Warning 330Hz, Urgent 220Hz pulsed).
  - Desktop Notification: Dispatches `new Notification(title, { body: message })` when permission is granted.
  - Chat Feed: Renders clean notification receipt card.

### 3.3 `host_info`
Exported from `src/lib/ai/tools/system.ts`.

#### Returns:
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

---

## 4. Quality, Safety & Anti-Slop Discipline

- **No Silent Failures (Rule 02):** Tool failures return clean, informative error payloads with exact path and issue descriptions instead of swallow-and-null.
- **Surgical Method (Rule 16):** File edits enforce unique string matching to prevent unexpected multi-site replacements.
- **Resource Discipline (Rule 18):** Directory scans and greps are bounded by maximum results (`--max-count 50`, max depth 5, output capped at 50KB) to prevent unbounded memory growth.
- **High Signal (Rule 22):** Formatted outputs avoid fluff and present clean tabular or indexed lines.
