# Architectural Specification: Project Workspaces & Agentic Coding Harness

**Date:** 2026-09-17  
**Status:** Approved (Final — Security & Architecture Hardened)  
**Author:** Anjasta Bagus Tarigan & Yggdrasil Cognitive Architecture Team  

---

## 1. Executive Summary

This specification defines the architectural design for re-introducing **Project Workspaces & Agentic Coding Harness** into Yggdrasil. 

In earlier iterations (commit `b0d896d`), an initial project feature was reverted due to:
1. **Siloed Duplication**: A monolithic 1,600+ line UI (`projects-view.tsx`) and parallel API routes (`/api/projects/chat`) duplicated the entire chat stack while drifting from core improvements (resumable streams, context compaction, tool approvals, subagents).
2. **Tool Collision & Hallucination**: Introducing prefixed tools (`projectBash`, `projectReadFile`) alongside base tools (`bash`, `file_operations`) confused LLMs regarding which tool to call and which directory was targeted.
3. **Premature Aborts**: Passing `abortSignal: req.signal` directly into `streamText` caused browser backgrounding or tab switching to sever active agent executions.

This final specification resolves those defects and guarantees complete security, caller authorization, and architectural isolation:
- **Strict Data & Memory Isolation**: Separate database tables (`projects`, `project_sessions`, `project_messages`) with dedicated `psess_` / `pmsg_` IDs and zero memory leakage into the global cognitive memory system (no embedding, no reranking, no `ingest_turn` jobs).
- **Per-Request Context-Bound Standard Tooling**: Builtin tools retain standard canonical names (`bash`, `file_operations`, `manage_tasks`) while a **per-request factory** dynamically binds working directory (`cwd`), permissions, and canonical realpath boundaries to the authorized project path without shared global state.
- **Dedicated Project System Prompt Engine**: A purpose-built prompt engine (`src/lib/ai/project-prompt.ts`) synthesizing best practices from Claude Code and Everything Claude Code (ECC)—enforcing tool hierarchy (dedicated tools over bash), verification gates (tests before completion claims), and reading local `AGENTS.md` / `CLAUDE.md`.
- **Comprehensive Defense-in-Depth Security & Caller Authorization**:
  - **Caller Authentication & Listener Boundary**: Strict loopback binding (`127.0.0.1`) by default, local host origin validation, and bearer token authorization when configured with `APP_SECRET` or running non-locally.
  - **Pre-Trust Permission Matrix**: Clear boundary between sandboxed new projects (`data/projects/`) and external existing directories with an explicit Restricted Mode (read-only inspection allowed, mutating/shell tools blocked until trust approval).
  - **Project Name Sanitization**: Whitelist validation against directory traversal (`../`) and OS-reserved names.
  - **Runtime TOCTOU Defense**: Validating canonical `realpath` on every request.
  - **Process Group Lifecycle Management**: Detached execution with timeout and escalation from `SIGTERM` $\to$ `SIGKILL`.
  - **Tool Approval Gate (HMAC-Signed)**: Exact heuristic classification of destructive shell commands (`rm -r`, `git reset --hard`, `pkill`, package installs) pausing for interactive confirmation.
  - **Honest Security Model**: Transparent disclosure that child processes share host OS user privileges, making the user Trust Barrier the primary defense.
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

### 3.1 Project Name Sanitization & Path Traversal Rejection
For projects created in `data/projects/<sanitized-name>/`:
- The name input is strictly validated by `sanitizeProjectName(name: string): string`:
  1. Input is trimmed, lowercased, and checked against length bounds (1 to 64 characters).
  2. Characters outside `[a-z0-9_-]` are stripped or replaced with hyphens. Consecutive hyphens are collapsed.
  3. Path traversal sequences (`..`, `/`, `\`) are strictly forbidden. If an input attempts traversal (e.g. `"../../home/user"`), the API immediately returns `400 Bad Request`.
  4. Reserved OS filenames (`con`, `prn`, `aux`, `nul`, `com1-9`, `lpt1-9`) are rejected.
  5. The target directory is lexically validated:
     `resolvedPath = path.resolve(DEFAULT_PROJECTS_DIR, sanitizedName)`
     `assert(resolvedPath.startsWith(DEFAULT_PROJECTS_DIR + path.sep))`

### 3.2 Two Project Modes & Pre-Trust Permission Matrix
1. **New Projects (`mode: "new"`)**:
   - Stored in `data/projects/<sanitized-name>/`.
   - Initialized with `trusted: true` because they reside within Yggdrasil's controlled storage.
   - Automatically bootstrapped with `AGENTS.md`, `CLAUDE.md`, and `.gitignore`.
2. **Existing Projects (`mode: "existing"`)**:
   - Points to an existing local directory (e.g. `/home/user/Projects/web-app`).
   - Default state: `trusted: false`.
   - Requires explicit confirmation in the UI via `POST /api/projects/[id]/trust`.

#### Pre-Trust Permission Matrix
When a project is untrusted (`trusted: false`), it operates in **Restricted Read-Only Mode**:

| Operation / Tool Call | `trusted: true` | `trusted: false` (Restricted Mode) |
| :--- | :---: | :---: |
| **Conversation & Reasoning** | ✅ Allowed | ✅ Allowed (agent can analyze, plan, explain) |
| **`file_operations: read`** | ✅ Allowed | ✅ Allowed (read-only inspection jailed to directory) |
| **`file_operations: list / find / grep`** | ✅ Allowed | ✅ Allowed (read-only search jailed to directory) |
| **`web_search` & `web_fetch`** | ✅ Allowed | ✅ Allowed (documentation retrieval) |
| **`manage_tasks`** | ✅ Allowed | ✅ Allowed (in-memory plan tracking) |
| **`file_operations: write`** | ✅ Allowed | ❌ **BLOCKED** (returns structured error: `Directory trust required to modify files`) |
| **`file_operations: edit`** | ✅ Allowed | ❌ **BLOCKED** (returns structured error: `Directory trust required to modify files`) |
| **`bash` (shell execution)** | ✅ Allowed* | ❌ **BLOCKED** (returns structured error: `Directory trust required to execute shell commands`) |

*\* Subject to interactive HMAC Tool Approval for destructive commands.*

### 3.3 Honest Security Model & Environment Scoping
**Honest Scope & Residual Risk:**
- `safeEnv` provides a clean environment (`PATH`, `HOME=projectDir`, `USER=project-agent`, `SHELL=/bin/bash`, `LANG=en_US.UTF-8`, `TERM=dumb`).
- **Critical Clarification:** Stripping server secrets (`OPENAI_API_KEY`, `APP_SECRET`, database connection strings) from `safeEnv` prevents child processes from reading secrets via environment inspection. **However, child processes run under the host OS user of the Node.js server.** They retain OS-level read permissions to files that user can access (`~/.ssh`, `~/.config`).
- Absolute containerization/virtualization (Docker, bubblewrap, firecracker) is out-of-scope for the host runner.
- Therefore, `safeEnv`, regex speed bumps, and realpath checks serve as **guardrails**, and the **Trust Barrier (§3.2)** is the primary human-in-the-loop authorization boundary.

### 3.4 TOCTOU (Time-of-Check to Time-of-Use) Defense
On every incoming request to `/api/projects/chat`, `/api/projects/[id]/files`, and file operations:
1. The server re-evaluates `fs.realpathSync(project.directoryPath)`.
2. If the directory has been moved, unmounted, or deleted (`ENOENT`), the request aborts with `404 Not Found` (`"Project directory no longer exists on disk"`).
3. The canonical path is used as the authoritative boundary for all path validations in that request.

### 3.5 Canonical Path Traversal & Symlink Jail Defense (Rule 06)
Paths are resolved and validated using both lexical checking and canonical realpath checks:
- **Lexical Check**: `resolved.startsWith(canonicalRoot + path.sep) || resolved === canonicalRoot`.
- **Symlink Check**: `fs.realpathSync(resolved)` must remain inside `canonicalRoot`. If a symlink points outside (e.g. `ln -s /etc ./keys`), the tool immediately throws: `Security Violation: Symlink escapes workspace root`.
- **Dangling / New Files**: For newly created files, the closest existing parent directory is canonicalized.

### 3.6 Child Process Lifecycle Management
- **Process Group Isolation**: Shell commands are spawned with `detached: true`.
- **Timeout & Kill Escalation**: 60-second execution cap. On timeout or user abort (`stop()`):
  1. Sends `process.kill(-pid, "SIGTERM")` to the entire process group.
  2. Sets a 2,000ms escalation timer. If the process has not exited, sends `process.kill(-pid, "SIGKILL")`.

### 3.7 Interactive Tool Approval Gate & Destructive Heuristics
Destructive commands trigger an interactive **Tool Approval Card** in the UI via Yggdrasil's HMAC-signed `experimental_toolApprovalSecret`. The approval secret is never exposed to the client or leaked in metadata.

**Classification Heuristics (`evaluateToolApproval`):**
1. **Recursive Deletions**: Commands matching `/\brm\s+-[a-zA-Z0-9]*r/i` or `/\brm\s+--recursive\b/i` require approval. Non-recursive file removal (e.g. `rm ./tmp.log`) is auto-approved inside project scope.
2. **Package Installations**: Any package addition/installation (`npm i/install`, `pnpm add/i/install`, `yarn add`, `bun add`, `pip install`, `cargo add`).
3. **Process Termination**: Any process kill commands (`kill`, `killall`, `pkill`).
4. **Destructive Git Operations**: Hard resets (`git reset --hard`), force pushes (`git push -f / --force`), and aggressive untracked cleans (`git clean -f`).
5. **Database / Infrastructure Verbs**: Dynamic or MCP tools matching `/(?:^|_)(delete|drop|destroy)(?:_|$)/i`.

### 3.8 API Endpoint Protection, Caller Authorization & Listener Boundary
To secure code execution and file operations from unauthorized non-browser callers as well as malicious web pages:
1. **Listener Binding**: Yggdrasil binds to the loopback interface (`127.0.0.1`) by default.
2. **Browser CSRF / Origin Validation**:
   - All mutating `/api/projects/*` endpoints (`POST`, `PATCH`, `DELETE`) require `Content-Type: application/json`.
   - The `Origin` or `Referer` header must strictly match the local server origin (`localhost` / `127.0.0.1`), preventing cross-site drive-by invocations from browser tabs.
3. **Caller Authentication**:
   - In production or when accessed non-locally, endpoints require a bearer token or authenticated session (`Authorization: Bearer <APP_SECRET>`).
   - Unauthenticated or invalid requests receive `401 Unauthorized`.
   - **Accepted deviation (loopback):** requests that arrive over the loopback interface are trusted without a token, even in production. The in-app browser UI has no login step and sends no `Authorization` header, so requiring a token on loopback would `401` every project call. The loopback listener binding (§3.8.1) is the primary boundary; the shared secret guards the non-local case (an explicit `HOSTNAME=0.0.0.0` opt-in, or a reverse proxy in front of the app, which `isLocalRequest` detects via forwarding headers). This is a deliberate, reviewed relaxation of the "in production" clause above, implemented in `src/app/api/projects/guard.ts`.
4. **Session Ownership Enforcement**:
   - Every project chat call validates that the target `sessionId` strictly belongs to the given `projectId`. A mismatch immediately rejects with `400 Bad Request` or `404 Not Found`.

---

## 4. Context-Bound Tooling Architecture

### 4.1 Per-Request Tool Factory (No Shared Global State)
To prevent cross-project state pollution and concurrency collisions, tools are created via a **per-request factory**:

```typescript
export function createProjectHarnessTools(options: {
  projectDirectory: string;
  trusted: boolean;
  canonicalRoot: string;
})
```

When a request arrives at `/api/projects/chat`:
1. The canonical root is resolved.
2. Fresh tool instances (`bash`, `file_operations`) are created bound to that `projectDirectory` and `trusted` flag.
3. If two users or sessions execute concurrently on different projects, their tool closures remain completely isolated.

### 4.2 Standard Tool Surface
Tools use standard, canonical names:
- **`bash`**: Executes shell commands inside `canonicalRoot`. Output is bounded to 30,000 characters with multibyte UTF-8 preservation via `StringDecoder`. Line boundaries are preserved during truncation, appending `…\n[output truncated at 30000 chars]`.
- **`file_operations`**: Unified filesystem tool with actions:
  - `read`: Reads line ranges with `offset` and `limit`.
  - `edit`: Exact substring replacement (`oldString` $\to$ `newString`) to minimize token generation and prevent full-file rewriting.
  - `write`: Writes or creates files up to 5MB.
  - `list`, `find`, `grep`: High-performance filesystem search with graceful fallback.
- **`manage_tasks`**: Structured task checklist for multi-step agentic planning.
- **`create_artifact`**: Renders standalone HTML/React deliverables.
- **`web_search` & `web_fetch`**: External documentation search and page retrieval.

### 4.3 Concurrency & Resource Limits
- **Max Concurrent Streams**: At most 1 active LLM generation stream per `project_session`. Subsequent requests on a session with an in-flight stream receive `409 Conflict` (`"Session stream is already in progress"`).
- **Autonomous Tool Step Limit**: Capped at 30 steps per turn (`stepCountIs(30)`).

---

## 5. Specialized Project System Prompt Engine

Created in `src/lib/ai/project-prompt.ts`, the prompt synthesizes directives from Claude Code and Everything Claude Code (ECC):

### 5.1 Prompt Construction Flow
```
┌────────────────────────────────────────────────────────┐
│ 1. Role & Environment (OS, Shell, Canonical Path, Git) │
├────────────────────────────────────────────────────────┤
│ 2. Project Instruction Injection (AGENTS.md/CLAUDE.md) │
├────────────────────────────────────────────────────────┤
│ 3. Custom Project Instructions (from DB)               │
├────────────────────────────────────────────────────────┤
│ 4. Tool Hierarchy & Discipline (Dedicated Tools > Bash)│
├────────────────────────────────────────────────────────┤
│ 5. Verification Gate (Run tests before claiming done)  │
├────────────────────────────────────────────────────────┤
│ 6. Output Efficiency & Anti-Slop (Zero preamble)       │
└────────────────────────────────────────────────────────┘
```

### 5.2 Key Directives
- **Dedicated Tools > Bash**: Never use shell commands (`cat`, `sed`, `awk`, `find`, `grep`) for file reading, search, or modification. Reserve `bash` strictly for builds, tests, package managers, and git commands.
- **Read Before Modifying**: Never propose or execute edits on a file without inspecting its contents first.
- **Surgical Edits**: Prefer `edit` over `write` on existing files to reduce token consumption and prevent accidental code deletion.
- **Verification Gate**: Before declaring a task finished, execute the relevant test suite or build check via `bash`. If tests fail, report the error honestly rather than manufacturing a false success claim.
- **High-Signal Output**: No pleasantries, conversational filler, or repeating the user's prompt. State the action, execute the tool, report findings with `file:line` citations.

---

## 6. Endpoints & API Contract

### 6.1 Project Management Endpoints
- `GET /api/projects`: List all registered projects with disk status check.
- `POST /api/projects`: Create a new project or register an existing directory. Enforces `sanitizeProjectName`.
- `GET /api/projects/[id]`: Get project details.
- `PATCH /api/projects/[id]`: Update metadata or custom instructions.
- `DELETE /api/projects/[id]`: Delete project, cascade sessions, and abort active streams.
- `POST /api/projects/[id]/trust`: Toggle directory trust status.
- `GET /api/projects/[id]/files`: Get directory file tree for UI explorer.

### 6.2 Session Management Endpoints
- `GET /api/projects/[id]/sessions`: List sessions for a project.
- `POST /api/projects/[id]/sessions`: Create a new session in a project.
- `GET /api/projects/[id]/sessions/[sessionId]`: Get session with messages.
- `DELETE /api/projects/[id]/sessions/[sessionId]`: Delete session; aborts any running `activeStreamId`.

### 6.3 Project Chat Endpoint (`POST /api/projects/chat`)
- **Payload**:
  ```json
  {
    "projectId": "proj_123",
    "sessionId": "psess_456",
    "messages": [ /* UIMessage[] */ ],
    "model": "optional_model_override",
    "effort": "xhigh"
  }
  ```
- **Execution Pipeline**:
  1. Validates Origin, caller authorization, `projectId`, and `sessionId`.
  2. Resolves canonical realpath of `project.directoryPath` (TOCTOU guard).
  3. Instantiates per-request toolset via `createProjectHarnessTools`.
  4. Synthesizes project prompt with `AGENTS.md` / `CLAUDE.md` and git status.
  5. Runs `streamText` with AI SDK v7, supporting reasoning tokens (claims token ⟡ / `type: "reasoning"`), tool approvals, and up to 30 autonomous tool steps.
  6. Emits stream via `publishStream` (no premature `abortSignal: req.signal`).
  7. Persists messages directly into `project_messages` and updates `project_sessions`.

---

## 7. User Interface & Experience

### 7.1 Projects Hub (`src/components/projects/ProjectsList.tsx`)
- Accessed via the **Projects** button in the main sidebar.
- Grid or list of registered projects:
  - Name, description, and directory path.
  - Disk existence indicator (`existsOnDisk`).
  - Trust badge (`Trusted` vs `Untrusted - Restricted Mode`).
  - Session count and last active timestamp.
- **New Project Dialog**: Creates a project in `data/projects/<sanitized-name>`.
- **Import Project Dialog**: Registers an existing path with Trust explanation.

### 7.2 Project Workspace View (`src/components/projects/ProjectWorkspace.tsx`)
- Active when viewing a specific project:
  - **Ambient Trust Banner**: If `trusted: false`, displays a warning banner with an "Approve Directory Trust" action button.
  - **Left Rail**: Project header (path, trust badge, settings trigger), session switcher, and `+ New Session` button.
  - **Center Canvas**: Full-featured chat area utilizing Yggdrasil's existing components:
    - Streaming message rendering.
    - Collapsible reasoning cards (`<Reasoning>`) with live duration and claims token ⟡ formatting.
    - Interactive terminal cards (`<ToolInvocation>`) showing exit code, command, and output.
    - Task checklists (`<TaskList>`).
    - Tool approval confirmation dialogs.
    - Bottom `PromptInput` with model picker and stop/submit controls.
  - **Right Drawer (Collapsible)**: File Tree explorer allowing quick file inspection.

---

## 8. Testing & Verification Strategy

### 8.1 Security & Sandbox Tests (`src/lib/__tests__/project-service.test.ts`)
- **Sanitization & Traversal**: `sanitizeProjectName("../../etc")` rejects traversal.
- **Symlink Jail**: Symlink pointing outside workspace (`ln -s /etc ./keys`) throws security violation.
- **TOCTOU**: Deleting/moving directory between check and call triggers `ENOENT` / 404 cleanly.
- **Process Group Termination**: Timed-out command triggers `SIGTERM` $\to$ `SIGKILL` escalation.
- **Environment Isolation**: Server secrets are absent from `safeEnv`.

### 8.2 Permission Matrix & Trust Tests (`src/app/api/__tests__/projects-chat-api.test.ts`)
- Untrusted project allows `file_operations: read` and `list`.
- Untrusted project blocks `file_operations: write` and `edit` with trust error.
- Untrusted project blocks `bash` with trust error.
- Trusted project executes `bash` and file write operations successfully.
- Tool approval gate: destructive command pauses in `approval-requested` and does not execute without valid HMAC signature.

### 8.3 Concurrency, HTTP Transport & Lifecycle Tests
- **HTTP Transport & Origin Guard**: Rejection of foreign Origin (e.g. `http://evil.com`) and non-JSON content types.
- **Caller Authentication**: Rejection of unauthenticated requests with 401 when production token/auth is configured.
- **Session Ownership Guard**: Rejection of requests where `sessionId` does not match `projectId`.
- **Tool Factory Concurrency**: Two simultaneous requests on different projects run with independent `cwd` and do not collide.
- **Stream Cleanup on Session Delete**: Deleting a session aborts active stream in `streamRegistry`.
- **Memory Isolation**: Project completion produces zero `ingest_turn` jobs in `job_queue` and zero rows in `episodic_memories` / `semantic_memories`.

### 8.4 UI Component Tests (`src/components/projects/__tests__/`)
- Creation dialog validation (name rules).
- Trust toggle and ambient banner rendering.
- Session switching and message continuity.
