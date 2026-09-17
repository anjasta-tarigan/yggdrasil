# Architectural Specification: Project Workspaces & Agentic Coding Harness

**Date:** 2026-09-17  
**Status:** Approved  
**Author:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team  

---

## 1. Executive Summary

This specification defines the architectural design for re-introducing **Project Workspaces & Agentic Coding Harness** into Yggdrasil. 

In earlier iterations (commit `b0d896d`), an initial project feature was reverted due to:
1. **Siloed Duplication**: A monolithic 1,600+ line UI (`projects-view.tsx`) and parallel API routes (`/api/projects/chat`) duplicated the entire chat stack while drifting from core improvements (resumable streams, context compaction, tool approvals, subagents).
2. **Tool Collision & Hallucination**: Introducing prefixed tools (`projectBash`, `projectReadFile`) alongside base tools (`bash`, `file_operations`) confused LLMs regarding which tool to call and which directory was targeted.
3. **Premature Aborts**: Passing `abortSignal: req.signal` directly into `streamText` caused browser backgrounding or tab switching to sever active agent executions.

This new architecture resolves those defects by establishing:
- **Strict Data & Memory Isolation**: Separate database tables (`projects`, `project_sessions`, `project_messages`) with dedicated `psess_` IDs and zero memory leakage into the global cognitive memory system (no embedding, no reranking, no `ingest_turn` jobs).
- **Context-Bound Standard Tooling**: Builtin tools retain standard canonical names (`bash`, `file_operations`, `manage_tasks`) while dynamically binding working directory (`cwd`) and canonical realpath boundaries to the authorized project path.
- **Dedicated Project System Prompt**: A purpose-built prompt engine (`src/lib/ai/project-prompt.ts`) synthesizing best practices from Claude Code and Everything Claude Code (ECC)—enforcing tool discipline, verification gates, and reading local `AGENTS.md` / `CLAUDE.md`.
- **Honest Defense-in-Depth Security**: Distinction between sandboxed new projects (`data/projects/`) and external existing directories with interactive Trust Authorization, process group cancellation (`SIGTERM` $\to$ `SIGKILL`), stripped environments, and HMAC-signed tool approvals for destructive commands.
- **Component Re-use**: Leveraging Yggdrasil's battle-tested UI primitives (`ChatMessageRow`, `ToolInvocation`, `TaskList`, `Reasoning`, `PromptInput`) inside a dedicated Project Workspace view.

---

## 2. Data Model & Database Schema

To ensure complete isolation between regular assistant conversations and coding project sessions, project data lives in dedicated SQLite tables managed by Drizzle ORM.

### 2.1 Table Schemas (`src/db/schema.ts`)

```typescript
/**
 * Projects workspace metadata. Tracks authorized/trusted directories
 * where full-stack harness coding agents run in isolated project scope.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(), // proj_<timestamp>_<nanoid>
  name: text("name").notNull(),
  description: text("description"),
  directoryPath: text("directory_path").notNull().unique(),
  isCustomDirectory: integer("is_custom_directory", { mode: "boolean" }).notNull().default(false),
  trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
  trustedAt: integer("trusted_at", { mode: "timestamp" }),
  customInstructions: text("custom_instructions"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

/**
 * Project-specific chat and orchestration sessions.
 * Completely distinct from chat_sessions (prefixed with psess_).
 */
export const projectSessions = sqliteTable(
  "project_sessions",
  {
    id: text("id").primaryKey(), // psess_<timestamp>_<nanoid>
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    activeStreamId: text("active_stream_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    projectIdx: index("idx_project_sessions_project_id").on(table.projectId),
  })
);

/**
 * Messages belonging to a project orchestration session.
 * Carries raw AI SDK UIMessage parts including tool invocations, results, and reasoning.
 */
export const projectMessages = sqliteTable(
  "project_messages",
  {
    id: text("id").primaryKey(), // pmsg_<timestamp>_<nanoid>
    sessionId: text("session_id")
      .notNull()
      .references(() => projectSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    sessionIdx: index("idx_project_messages_session_id").on(table.sessionId),
  })
);
```

### 2.2 Memory Isolation Invariant
- **Zero Ingestion**: When a project message stream completes, the backend **never** enqueues `ingest_turn`, `reflect_turn`, or background memory graph jobs.
- **Zero Retrieval**: When generating responses for project sessions, `hybridMemorySearch` and `semanticMemories` are **never** queried.
- **Zero Pollution**: Code diffs, compiler errors, build outputs, and stack traces generated during coding turns remain strictly contained within `project_messages` and never leak into personal assistant episodic or semantic memories.

---

## 3. Security, Directory Containment & Defense-in-Depth

The Project Harness runs code and interacts with files on the local machine. Absolute host isolation without virtualization requires a layered defense-in-depth model:

### 3.1 Two Project Modes & The Trust Barrier
1. **New Projects (`mode: "new"`)**:
   - Stored in `data/projects/<sanitized-name>/`.
   - Initialized with `trusted: true` because they reside within Yggdrasil's controlled data store.
   - Automatically bootstrapped with:
     - `AGENTS.md` (project guidelines wired to `CLAUDE.md`).
     - `CLAUDE.md` (`@AGENTS.md`).
     - `.gitignore` (`node_modules/`, `.next/`, `dist/`, `.env*`, etc.).
2. **Existing Projects (`mode: "existing"`)**:
   - Points to any existing local directory path (e.g. `/home/user/Projects/web-app`).
   - Default state: `trusted: false`.
   - **Trust Barrier**: Tool execution (`bash` and file write/edit operations) is completely blocked until the user explicitly confirms trust via the Project Trust Dialog in the UI (`POST /api/projects/[id]/trust`).

### 3.2 Canonical Path Traversal & Symlink Jail Defense (Rule 06)
Paths are resolved and validated using both lexical checking and canonical filesystem realpath checks:
- **Lexical Check**: `resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot`.
- **Symlink Check**: `fs.realpathSync(resolved)` must remain inside `fs.realpathSync(normalizedRoot)`. If a symlink points outside (e.g. `ln -s /etc ./keys`), the tool immediately throws: `Security Violation: Symlink escapes workspace root`.
- **Dangling / New Files**: For new files, the closest existing ancestor directory is canonicalized to ensure no parent symlink escapes the boundary.

### 3.3 Child Process Lifecycle Management
Shell commands executed through `bash` in project scope:
- **Process Group Isolation**: Spawned with `detached: true` so child and subprocesses belong to a distinct process group.
- **Stripped Environment (`safeEnv`)**: Server secrets (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `APP_SECRET`, database paths, internal tokens) are wiped from `process.env`. The child process receives only standard execution variables (`PATH`, `HOME=projectDir`, `USER=project-agent`, `SHELL=/bin/bash`, `LANG=en_US.UTF-8`, `TERM=dumb`).
- **Timeout & Kill Escalation**: 60-second execution cap. On timeout or user abort (`stop()`):
  1. Sends `process.kill(-pid, "SIGTERM")` to the entire process group.
  2. Sets a 2,000ms escalation timer. If the process has not terminated, sends `process.kill(-pid, "SIGKILL")`.

### 3.4 Interactive Tool Approval Gate
Destructive commands (such as `rm -rf`, `git reset --hard`, `git clean -fd`, dropping database schemas, or installing system packages) trigger an interactive **Tool Approval Card** in the UI via Yggdrasil's HMAC-signed `experimental_toolApprovalSecret` before execution can proceed.

---

## 4. Context-Bound Tooling Architecture

Instead of creating divergent tool names (`projectBash`, `projectReadFile`), the harness exposes canonical tools that are dynamically scoped to the project directory:

```
┌────────────────────────────────────────────────────────┐
│                   Harness Toolset                      │
├────────────────────────────────────────────────────────┤
│ • bash            (cwd = project.directoryPath)       │
│ • file_operations (root = project.directoryPath)       │
│ • manage_tasks    (agentic milestone tracking)         │
│ • create_artifact (interactive HTML/React deliverables)│
│ • web_search      (external docs & reference)          │
│ • fetch_page      (documentation retrieval)            │
└────────────────────────────────────────────────────────┘
```

- **`bash`**: Runs shell commands inside `project.directoryPath`. Truncates output cleanly at 30,000 characters to protect context limits. Multibyte UTF-8 boundaries are preserved using `StringDecoder`.
- **`file_operations`**: Comprehensive tool with actions `read`, `write`, `edit`, `list`, `find`, and `grep`:
  - `read`: Reads line ranges with `offset` and `limit`.
  - `edit`: Exact substring find-and-replace (`oldString` $\to$ `newString`) to minimize token generation and preserve file structure.
  - `write`: Creates or overwrites files (limited to 5MB max payload).
  - `list` / `find` / `grep`: Uses high-performance CLI tools (`eza`, `fd`, `rg`) when available, with graceful Node.js filesystem fallbacks.
- **`manage_tasks`**: Structured task checklist for planning multi-step implementations.

---

## 5. Specialized Project System Prompt Engine

Created in `src/lib/ai/project-prompt.ts`, the project system prompt incorporates principles from Claude Code and Everything Claude Code (ECC):

### 5.1 Prompt Construction Flow
```
┌───────────────────────────────────────────────────────┐
│ 1. Role & Working Environment (OS, Shell, Git Branch)  │
├───────────────────────────────────────────────────────┤
│ 2. Project Instruction Injection (AGENTS.md/CLAUDE.md)│
├───────────────────────────────────────────────────────┤
│ 3. Custom Project Instructions (from DB)              │
├───────────────────────────────────────────────────────┤
│ 4. Tool Hierarchy & Discipline (Dedicated Tools > Bash)│
├───────────────────────────────────────────────────────┤
│ 5. Verification Gate (Run tests before claiming done) │
├───────────────────────────────────────────────────────┤
│ 6. High-Signal Communication (Zero preamble / slop)   │
└───────────────────────────────────────────────────────┘
```

### 5.2 Key Directives
- **Dedicated Tools > Bash**: Never use bash commands (`cat`, `head`, `sed`, `awk`, `find`, `grep`) for file reading, search, or modification when `file_operations` exists. Reserve `bash` strictly for builds, tests, package managers, and git commands.
- **Read Before Modifying**: Never propose or execute edits on a file without inspecting its contents first.
- **Surgical Edits**: Always prefer `edit` over `write` on existing files to reduce token consumption and prevent accidental overwrites.
- **Verification Gate**: Before declaring a task finished, execute the relevant test command or build check via `bash`. If tests fail, report the error honestly rather than manufacturing a false success claim.
- **Direct & Terse Output**: No pleasantries, conversational filler, or repeating the user's prompt. State the action, execute the tool, report findings with `file:line` citations.

---

## 6. Endpoints & API Contract

### 6.1 Project Management Endpoints
- `GET /api/projects`: List all registered projects with disk status check.
- `POST /api/projects`: Create a new project or register an existing directory.
- `GET /api/projects/[id]`: Get project details.
- `PATCH /api/projects/[id]`: Update project metadata or custom instructions.
- `DELETE /api/projects/[id]`: Delete project and cascade its sessions and messages.
- `POST /api/projects/[id]/trust`: Toggle directory trust status.
- `GET /api/projects/[id]/files`: Get directory file tree for UI explorer.

### 6.2 Session Management Endpoints
- `GET /api/projects/[id]/sessions`: List sessions for a project.
- `POST /api/projects/[id]/sessions`: Create a new session in a project.
- `GET /api/projects/[id]/sessions/[sessionId]`: Get session with messages.
- `DELETE /api/projects/[id]/sessions/[sessionId]`: Delete a session.

### 6.3 Project Chat Endpoint (`POST /api/projects/chat`)
- **Payload**:
  ```json
  {
    "projectId": "proj_123",
    "sessionId": "psess_456",
    "messages": [ /* UIMessage[] */ ],
    "model": "anthropic/claude-3-7-sonnet",
    "effort": "xhigh"
  }
  ```
- **Execution Pipeline**:
  1. Validates project existence and trust status.
  2. Binds `bash` and `file_operations` to `project.directoryPath`.
  3. Synthesizes project prompt with `AGENTS.md` / `CLAUDE.md` and git status.
  4. Runs `streamText` with AI SDK v7, supporting reasoning tokens (`<think>`), tool approvals, and up to 30 autonomous tool steps.
  5. Uses resumable stream pattern via `publishStream` (no premature `abortSignal: req.signal` aborts).
  6. Persists messages directly into `project_messages` and updates `project_sessions`.

---

## 7. User Interface & Experience

The UI is divided cleanly into two cohesive views:

### 7.1 Projects Hub (`src/components/projects/ProjectsList.tsx`)
- Accessed via the **Projects** button in the main sidebar.
- Grid or list of registered projects displaying:
  - Project name, description, and directory path.
  - Disk existence indicator (`existsOnDisk`).
  - Trust badge (`Trusted` vs `Untrusted - Approval Required`).
  - Session count and last active timestamp.
- **New Project Dialog**: Creates a project in `data/projects/<name>`.
- **Import Project Dialog**: Registers an existing local path with Trust explanation.

### 7.2 Project Workspace View (`src/components/projects/ProjectWorkspace.tsx`)
- Active when viewing a specific project:
  - **Left Rail**: Project header (path, trust badge, settings trigger), session switcher, and `+ New Session` button.
  - **Center Canvas**: Full-featured chat area utilizing Yggdrasil's existing components:
    - Streaming message rendering.
    - Collapsible reasoning cards (`<Reasoning>`) with live duration.
    - Interactive terminal cards (`<ToolInvocation>`) showing exit code, command, and output.
    - Task checklists (`<TaskList>`).
    - Tool approval confirmation dialogs.
    - Bottom `PromptInput` with model picker and stop/submit controls.
  - **Right Drawer (Collapsible)**: File Tree explorer allowing quick file inspection.

---

## 8. Testing & Verification Strategy

### 8.1 Security & Sandbox Tests (`src/lib/__tests__/project-service.test.ts`)
- Path traversal rejection (`../../etc/passwd`).
- Symlink jail breakout detection (`ln -s /etc ./keys`).
- Process group termination upon timeout (`SIGTERM` $\to$ `SIGKILL`).
- Environment variable stripping (no leaked API keys in `bash`).

### 8.2 API & Chat Stream Tests (`src/app/api/__tests__/projects-api.test.ts`, `projects-chat-api.test.ts`)
- Project CRUD and session cascade deletions.
- Trust requirement enforcement (403 when untrusted).
- Multi-step tool execution stream.
- Zero memory leakage verification (ensuring `ingest_turn` is never dispatched for project sessions).

### 8.3 UI Component Tests (`src/components/projects/__tests__/`)
- Project creation dialogs (new vs existing).
- Trust approval button and confirmation state.
- Session switching and message continuity.
