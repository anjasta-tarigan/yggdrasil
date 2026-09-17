# Project Workspaces & Agentic Coding Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full-stack Project Workspaces and an Agentic Coding Harness with isolated SQLite persistence, per-request directory-scoped canonical tools (`bash`, `file_operations`), dedicated Claude Code/ECC-inspired system prompt, honest defense-in-depth security (Trust Barrier, process-group management, HMAC approvals, caller authorization), and zero cognitive memory leakage.

**Architecture:** 
- Isolated database schema (`projects`, `project_sessions`, `project_messages`) with dedicated `psess_` / `pmsg_` IDs, cascade deletions, and zero memory ingestion (`ingest_turn` jobs or vector embeddings are never dispatched for project sessions).
- Per-request harness tool factory (`createProjectHarnessTools`) providing standard canonical tool names (`bash`, `file_operations`, `manage_tasks`, `create_artifact`, `web_search`, `web_fetch`) bound strictly to canonical project realpaths, enforcing the Pre-Trust Permission Matrix (read-only when untrusted; mutating/bash tools blocked until user trust approval).
- Specialized project system prompt engine (`synthesizeProjectSystemPrompt`) that injects local `AGENTS.md` / `CLAUDE.md`, enforces tool hierarchy (dedicated tools over bash), test verification before completion, and anti-slop communication.
- REST management endpoints (`/api/projects*`) and streaming chat runner (`/api/projects/chat`) with caller authentication, Origin/CSRF validation, TOCTOU realpath verification, and `streamRegistry` lifecycle tracking.
- Interactive UI comprising a **Projects Hub** (`ProjectsList`) and **Project Workspace View** (`ProjectWorkspace`) reusing Yggdrasil's battle-tested chat primitives (`ChatMessageRow`, `ToolInvocation`, `TaskList`, `Reasoning`, `PromptInput`).

**Tech Stack:** Next.js 16 (App Router), AI SDK v7 (`ai`, `@ai-sdk/react`), Drizzle ORM, better-sqlite3, Tailwind CSS v4, Radix UI, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-17-project-workspaces-harness-design.md`

## Global Constraints
- Strictly adhere to Rule 06 (System Isolation / Directory Jailing).
- Child processes run detached with process group `SIGTERM` $\to$ `SIGKILL` escalation (2000ms grace period) and stripped `safeEnv`.
- Server secrets (`APP_SECRET`, API keys, DB paths) must never leak into child process environments or client metadata.
- Pre-Trust Permission Matrix must be enforced: untrusted projects allow read/list/grep, but block write/edit/bash.
- Zero memory leakage invariant: project turns must never query `semantic_memories` or dispatch `ingest_turn` background jobs.
- All test runs must run sequentially (`--project unit` or `--project integration`) to avoid kernel OOM (Rule 18).

---

### Task 1: Database Schema & Migration for Projects

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/init.ts`
- Test: `src/db/__tests__/projects-schema.test.ts`

**Interfaces:**
- Consumes: Drizzle SQLite primitives (`sqliteTable`, `text`, `integer`, `index`, `sql`)
- Produces: Exported table definitions `projects`, `projectSessions`, `projectMessages`

- [ ] **Step 1: Write failing unit test for project schema tables**

```typescript
// src/db/__tests__/projects-schema.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";

describe("Projects Schema", () => {
  it("creates projects, projectSessions, and projectMessages tables with correct columns and relations", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });

    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        directory_path TEXT NOT NULL UNIQUE,
        is_custom_directory INTEGER NOT NULL DEFAULT 0,
        trusted INTEGER NOT NULL DEFAULT 0,
        trusted_at INTEGER,
        custom_instructions TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE project_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        active_stream_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX idx_project_sessions_project_id ON project_sessions(project_id);

      CREATE TABLE project_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX idx_project_messages_session_id ON project_messages(session_id);
    `);

    // Insert test project
    const now = new Date();
    db.insert(schema.projects)
      .values({
        id: "proj_test_1",
        name: "test-project",
        directoryPath: "/tmp/test-project",
        trusted: true,
        trustedAt: now,
      })
      .run();

    const [proj] = db.select().from(schema.projects).all();
    expect(proj).toBeDefined();
    expect(proj.id).toBe("proj_test_1");
    expect(proj.trusted).toBe(true);

    // Insert session
    db.insert(schema.projectSessions)
      .values({
        id: "psess_test_1",
        projectId: "proj_test_1",
        title: "Initial Session",
      })
      .run();

    const [sess] = db.select().from(schema.projectSessions).all();
    expect(sess).toBeDefined();
    expect(sess.id).toBe("psess_test_1");
    expect(sess.projectId).toBe("proj_test_1");

    // Insert message
    db.insert(schema.projectMessages)
      .values({
        id: "pmsg_test_1",
        sessionId: "psess_test_1",
        role: "user",
        content: "Hello harness",
        metadata: { parts: [{ type: "text", text: "Hello harness" }] },
      })
      .run();

    const [msg] = db.select().from(schema.projectMessages).all();
    expect(msg).toBeDefined();
    expect(msg.content).toBe("Hello harness");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/db/__tests__/projects-schema.test.ts`  
Expected: FAIL (schema exports missing)

- [ ] **Step 3: Implement `projects`, `projectSessions`, and `projectMessages` in `src/db/schema.ts` and `src/db/init.ts`**

Add table definitions to `src/db/schema.ts`:
```typescript
/**
 * Projects workspace metadata. Tracks authorized/trusted directories
 * where full-stack harness coding agents run in isolated project scope.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  directoryPath: text("directory_path").notNull().unique(),
  isCustomDirectory: integer("is_custom_directory", { mode: "boolean" })
    .notNull()
    .default(false),
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
 */
export const projectSessions = sqliteTable(
  "project_sessions",
  {
    id: text("id").primaryKey(),
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
 */
export const projectMessages = sqliteTable(
  "project_messages",
  {
    id: text("id").primaryKey(),
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

Add DDL statements in `src/db/init.ts` table initialization function.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/db/__tests__/projects-schema.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/init.ts src/db/__tests__/projects-schema.test.ts
git commit -m "feat(db): add projects, projectSessions, and projectMessages schema tables"
```

---

### Task 2: Project Service Core & TOCTOU Defense

**Files:**
- Create: `src/lib/project-service.ts`
- Test: `src/lib/__tests__/project-service.test.ts`

**Interfaces:**
- Consumes: `db`, `projects`, `projectSessions`, `projectMessages`
- Produces:
  - `sanitizeProjectName(name: string): string`
  - `resolveCanonicalProjectPath(projectPath: string): Promise<string>`
  - `listProjects(db?: AppDatabase): Promise<StoredProject[]>`
  - `getProject(id: string, db?: AppDatabase): Promise<StoredProject | null>`
  - `createProject(input: CreateProjectInput, db?: AppDatabase): Promise<StoredProject>`
  - `updateProject(id: string, updates: UpdateProjectInput, db?: AppDatabase): Promise<StoredProject | null>`
  - `setProjectTrusted(id: string, trusted: boolean, db?: AppDatabase): Promise<StoredProject | null>`
  - `deleteProject(id: string, db?: AppDatabase): Promise<void>`
  - `listProjectSessions(projectId: string, db?: AppDatabase): Promise<StoredProjectSession[]>`
  - `getProjectSession(sessionId: string, db?: AppDatabase): Promise<StoredProjectSession | null>`
  - `saveProjectSession(session: StoredProjectSession, db?: AppDatabase): Promise<void>`
  - `deleteProjectSession(sessionId: string, db?: AppDatabase): Promise<void>`

- [ ] **Step 1: Write failing unit tests for project name sanitization, path security, and CRUD**

```typescript
// src/lib/__tests__/project-service.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import {
  sanitizeProjectName,
  resolveCanonicalProjectPath,
  createProject,
  getProject,
  setProjectTrusted,
  deleteProject,
  saveProjectSession,
  getProjectSession,
} from "../project-service";

describe("Project Service", () => {
  let testDir: string;
  let sqlite: Database.Database;
  let testDb: any;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-proj-test-"));
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        directory_path TEXT NOT NULL UNIQUE,
        is_custom_directory INTEGER NOT NULL DEFAULT 0,
        trusted INTEGER NOT NULL DEFAULT 0,
        trusted_at INTEGER,
        custom_instructions TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE TABLE project_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        active_stream_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE TABLE project_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES project_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
    `);
    testDb = drizzle(sqlite, { schema });
  });

  it("sanitizes valid project names and rejects path traversal sequences", () => {
    expect(sanitizeProjectName("My Awesome App")).toBe("my-awesome-app");
    expect(sanitizeProjectName("web_service-2026")).toBe("web_service-2026");

    expect(() => sanitizeProjectName("../../../etc/passwd")).toThrow();
    expect(() => sanitizeProjectName("foo/bar")).toThrow();
    expect(() => sanitizeProjectName("con")).toThrow();
    expect(() => sanitizeProjectName("")).toThrow();
  });

  it("resolves canonical project path and detects missing directories (TOCTOU guard)", async () => {
    const canonical = await resolveCanonicalProjectPath(testDir);
    expect(canonical).toBe(await fs.realpath(testDir));

    await expect(
      resolveCanonicalProjectPath(path.join(testDir, "non_existent_folder"))
    ).rejects.toThrow(/does not exist/);
  });

  it("creates a new project and scaffolds AGENTS.md, CLAUDE.md, and .gitignore", async () => {
    const proj = await createProject(
      {
        name: "scaffold-test",
        mode: "new",
        customBaseDir: testDir,
      },
      testDb
    );

    expect(proj.id).toMatch(/^proj_/);
    expect(proj.trusted).toBe(true); // new projects in sandbox are trusted
    expect(proj.name).toBe("scaffold-test");

    const agentsContent = await fs.readFile(path.join(proj.directoryPath, "AGENTS.md"), "utf8");
    expect(agentsContent).toContain("# scaffold-test");
    const claudeContent = await fs.readFile(path.join(proj.directoryPath, "CLAUDE.md"), "utf8");
    expect(claudeContent).toContain("@AGENTS.md");
  });

  it("creates an existing project as untrusted and toggles trust status", async () => {
    const existingDir = path.join(testDir, "existing-app");
    await fs.mkdir(existingDir);

    const proj = await createProject(
      {
        name: "Existing App",
        directoryPath: existingDir,
        mode: "existing",
      },
      testDb
    );

    expect(proj.trusted).toBe(false);

    const trusted = await setProjectTrusted(proj.id, true, testDb);
    expect(trusted?.trusted).toBe(true);
    expect(trusted?.trustedAt).toBeDefined();
  });

  it("persists sessions with messages using batching", async () => {
    const proj = await createProject(
      { name: "batch-test", mode: "new", customBaseDir: testDir },
      testDb
    );

    await saveProjectSession(
      {
        id: "psess_123",
        projectId: proj.id,
        title: "Session 1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: "pmsg_1",
            role: "user",
            parts: [{ type: "text", text: "Task plan" }],
          },
        ],
      },
      testDb
    );

    const loaded = await getProjectSession("psess_123", testDb);
    expect(loaded).toBeDefined();
    expect(loaded?.title).toBe("Session 1");
    expect(loaded?.messages.length).toBe(1);
    expect(loaded?.messages[0].role).toBe("user");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/project-service.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/lib/project-service.ts`**

Implement name sanitization, path verification, scaffolding, and DB transaction functions.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/project-service.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-service.ts src/lib/__tests__/project-service.test.ts
git commit -m "feat(projects): implement project service core with sanitization and TOCTOU defense"
```

---

### Task 3: Per-Request Project Harness Tools Factory & Pre-Trust Permission Matrix

**Files:**
- Create: `src/lib/project-harness-tools.ts`
- Test: `src/lib/__tests__/project-harness-tools.test.ts`

**Interfaces:**
- Consumes: `fs/promises`, `child_process`, `assertSafeCommand`, `assertSafePath`
- Produces:
  - `createProjectHarnessTools(options: { projectDirectory: string; canonicalRoot: string; trusted: boolean })`
  - Canonical tools: `bash`, `file_operations`

- [ ] **Step 1: Write failing unit tests for per-request tools and permission matrix**

```typescript
// src/lib/__tests__/project-harness-tools.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createProjectHarnessTools } from "../project-harness-tools";

describe("Project Harness Tools", () => {
  let testDir: string;
  let canonicalRoot: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-tools-test-"));
    canonicalRoot = await fs.realpath(testDir);
    await fs.writeFile(path.join(canonicalRoot, "hello.txt"), "Line 1\nLine 2\nLine 3");
  });

  it("enforces Pre-Trust Permission Matrix: blocks write and bash when untrusted", async () => {
    const untrustedTools = createProjectHarnessTools({
      projectDirectory: testDir,
      canonicalRoot,
      trusted: false,
    });

    // 1. Read is allowed in untrusted mode
    const readResult: any = await untrustedTools.file_operations.execute({
      action: "read",
      path: "hello.txt",
    });
    expect(readResult.content).toContain("Line 1");

    // 2. Write is blocked in untrusted mode
    const writeResult: any = await untrustedTools.file_operations.execute({
      action: "write",
      path: "test.txt",
      content: "blocked",
    });
    expect(writeResult.error).toMatch(/trust required/i);

    // 3. Bash is blocked in untrusted mode
    const bashResult: any = await untrustedTools.bash.execute({
      command: "echo test",
    });
    expect(bashResult.stderr).toMatch(/trust required/i);
    expect(bashResult.exitCode).toBe(126);
  });

  it("allows bash and write execution when project is trusted", async () => {
    const trustedTools = createProjectHarnessTools({
      projectDirectory: testDir,
      canonicalRoot,
      trusted: true,
    });

    // Write works
    const writeResult: any = await trustedTools.file_operations.execute({
      action: "write",
      path: "created.txt",
      content: "Hello World",
    });
    expect(writeResult.status).toBe("success");

    // Bash works in project cwd
    const bashResult: any = await trustedTools.bash.execute({
      command: "cat created.txt && pwd",
    });
    expect(bashResult.exitCode).toBe(0);
    expect(bashResult.stdout).toContain("Hello World");
    expect(bashResult.stdout).toContain(canonicalRoot);
  });

  it("detects symlink jail escape in file operations", async () => {
    const secretFile = path.join(os.tmpdir(), "outside_secret.txt");
    await fs.writeFile(secretFile, "secret");

    const symlinkPath = path.join(canonicalRoot, "escape_link");
    await fs.symlink(secretFile, symlinkPath);

    const tools = createProjectHarnessTools({
      projectDirectory: testDir,
      canonicalRoot,
      trusted: true,
    });

    const readResult: any = await tools.file_operations.execute({
      action: "read",
      path: "escape_link",
    });
    expect(readResult.error).toMatch(/security violation|escapes workspace/i);
  });

  it("isolates environments across concurrent tool instances", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-other-"));
    const otherCanonical = await fs.realpath(otherDir);

    const tools1 = createProjectHarnessTools({
      projectDirectory: testDir,
      canonicalRoot,
      trusted: true,
    });
    const tools2 = createProjectHarnessTools({
      projectDirectory: otherDir,
      canonicalRoot: otherCanonical,
      trusted: true,
    });

    const [res1, res2]: any[] = await Promise.all([
      tools1.bash.execute({ command: "pwd" }),
      tools2.bash.execute({ command: "pwd" }),
    ]);

    expect(res1.stdout.trim()).toBe(canonicalRoot);
    expect(res2.stdout.trim()).toBe(otherCanonical);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/__tests__/project-harness-tools.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/lib/project-harness-tools.ts`**

Implement `createProjectHarnessTools` with process group management, UTF-8 StringDecoder, safeEnv, symlink detection, and permission matrix gating.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/__tests__/project-harness-tools.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-harness-tools.ts src/lib/__tests__/project-harness-tools.test.ts
git commit -m "feat(projects): implement per-request harness tools with permission matrix and symlink defense"
```

---

### Task 4: Specialized Project System Prompt Engine

**Files:**
- Create: `src/lib/ai/project-prompt.ts`
- Test: `src/lib/ai/__tests__/project-prompt.test.ts`

**Interfaces:**
- Consumes: StoredProject, git branch/status, local filesystem
- Produces: `synthesizeProjectSystemPrompt(project: StoredProject): Promise<string>`

- [ ] **Step 1: Write failing unit test for project prompt synthesis**

```typescript
// src/lib/ai/__tests__/project-prompt.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { synthesizeProjectSystemPrompt } from "../project-prompt";
import type { StoredProject } from "@/lib/project-service";

describe("Project System Prompt Engine", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-prompt-test-"));
  });

  it("synthesizes prompt with environment info, tool discipline, and anti-slop rules", async () => {
    const project: StoredProject = {
      id: "proj_1",
      name: "Prompt Test Project",
      description: "A test project",
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: "Use strict TypeScript with no any.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);

    // Checks essential ECC/Claude Code sections
    expect(prompt).toContain("Prompt Test Project");
    expect(prompt).toContain(testDir);
    expect(prompt).toContain("Dedicated Tools > Bash");
    expect(prompt).toContain("Verification Gate");
    expect(prompt).toContain("Use strict TypeScript with no any.");
    expect(prompt).not.toContain("<cognitive_memory_context>"); // Zero memory leakage
  });

  it("injects AGENTS.md content when present in directory root", async () => {
    await fs.writeFile(
      path.join(testDir, "AGENTS.md"),
      "## Test Instructions\nAlways run vitest before finishing."
    );

    const project: StoredProject = {
      id: "proj_2",
      name: "Agent Doc Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("Always run vitest before finishing.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ai/__tests__/project-prompt.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/lib/ai/project-prompt.ts`**

Synthesize the prompt:
1. Role and operational environment (platform, shell, project directory).
2. Git status / branch detection.
3. Reading `AGENTS.md` / `CLAUDE.md`.
4. Custom instructions from database.
5. Tool hierarchy (dedicated tools > bash, read before modify, surgical edits).
6. Verification gate (test verification before claiming done).
7. High-signal anti-slop communication.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/ai/__tests__/project-prompt.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/project-prompt.ts src/lib/ai/__tests__/project-prompt.test.ts
git commit -m "feat(projects): add specialized project system prompt engine"
```

---

### Task 5: Project Management & Session REST API Endpoints

**Files:**
- Create: `src/app/api/projects/route.ts`
- Create: `src/app/api/projects/[id]/route.ts`
- Create: `src/app/api/projects/[id]/trust/route.ts`
- Create: `src/app/api/projects/[id]/files/route.ts`
- Create: `src/app/api/projects/[id]/sessions/route.ts`
- Create: `src/app/api/projects/[id]/sessions/[sessionId]/route.ts`
- Test: `src/app/api/__tests__/projects-api.test.ts`

**Interfaces:**
- Consumes: `project-service.ts`, `stream-registry.ts`
- Produces: REST endpoints for project CRUD, sessions, trust toggle, and file tree

- [ ] **Step 1: Write failing integration tests for project REST endpoints**

```typescript
// src/app/api/__tests__/projects-api.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GET as listProjectsGet, POST as createProjectPost } from "../projects/route";
import { GET as getProjectGet, DELETE as deleteProjectDelete } from "../projects/[id]/route";
import { POST as trustProjectPost } from "../projects/[id]/trust/route";

describe("Projects REST API", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-api-test-"));
  });

  it("validates Origin and Content-Type on mutating requests", async () => {
    // Bad Origin
    const badOriginReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://attacker.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "test-proj", mode: "new" }),
    });
    const res = await createProjectPost(badOriginReq);
    expect(res.status).toBe(403);
  });

  it("creates a new project and lists it", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Api Test App", mode: "new" }),
    });

    const res = await createProjectPost(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^proj_/);

    const listRes = await listProjectsGet(new Request("http://localhost:3000/api/projects"));
    const list = await listRes.json();
    expect(list.some((p: any) => p.id === body.id)).toBe(true);
  });

  it("toggles directory trust status via POST /api/projects/[id]/trust", async () => {
    const existingDir = path.join(testDir, "existing-dir");
    await fs.mkdir(existingDir);

    const createReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Untrusted App",
        directoryPath: existingDir,
        mode: "existing",
      }),
    });
    const createRes = await createProjectPost(createReq);
    const proj = await createRes.json();
    expect(proj.trusted).toBe(false);

    const trustReq = new Request(`http://localhost:3000/api/projects/${proj.id}/trust`, {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trusted: true }),
    });
    const trustRes = await trustProjectPost(trustReq, { params: Promise.resolve({ id: proj.id }) });
    expect(trustRes.status).toBe(200);
    const updated = await trustRes.json();
    expect(updated.trusted).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/__tests__/projects-api.test.ts`  
Expected: FAIL (routes missing)

- [ ] **Step 3: Implement all project REST API routes**

Implement:
- `src/app/api/projects/route.ts`
- `src/app/api/projects/[id]/route.ts`
- `src/app/api/projects/[id]/trust/route.ts`
- `src/app/api/projects/[id]/files/route.ts`
- `src/app/api/projects/[id]/sessions/route.ts`
- `src/app/api/projects/[id]/sessions/[sessionId]/route.ts`
With Origin verification, JSON headers, and session cleanup.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/__tests__/projects-api.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/ src/app/api/__tests__/projects-api.test.ts
git commit -m "feat(api): implement project management and session REST endpoints"
```

---

### Task 6: Project Harness Chat API Route (`/api/projects/chat`)

**Files:**
- Create: `src/app/api/projects/chat/route.ts`
- Test: `src/app/api/__tests__/projects-chat-api.test.ts`

**Interfaces:**
- Consumes: `streamText`, `createProjectHarnessTools`, `synthesizeProjectSystemPrompt`, `streamRegistry`
- Produces: `POST /api/projects/chat` streaming response

- [ ] **Step 1: Write failing integration tests for project chat streaming, concurrency, and memory isolation**

```typescript
// src/app/api/__tests__/projects-chat-api.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { POST as chatPost } from "../projects/chat/route";
import { createProject, saveProjectSession } from "@/lib/project-service";
import * as queue from "@/lib/queue/queue";

describe("Project Chat API Route", () => {
  let testDir: string;
  let proj: any;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-chat-test-"));
    proj = await createProject({
      name: "chat-test-app",
      mode: "new",
      customBaseDir: testDir,
    });
    await saveProjectSession({
      id: "psess_chat_1",
      projectId: proj.id,
      title: "Chat 1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    });
  });

  it("rejects request with mismatched session and project id", async () => {
    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_non_existent",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(404);
  });

  it("never dispatches ingest_turn queue jobs for project sessions (Zero Memory Leakage)", async () => {
    const enqueueSpy = vi.spyOn(queue, "enqueueJob");

    const req = new Request("http://localhost:3000/api/projects/chat", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId: proj.id,
        sessionId: "psess_chat_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Explain files" }] }],
      }),
    });

    const res = await chatPost(req);
    expect(res.status).toBe(200);

    // Consume stream
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    // Verify zero memory ingestion jobs
    const ingestCalls = enqueueSpy.mock.calls.filter(([job]) => job.type === "ingest_turn");
    expect(ingestCalls.length).toBe(0);
    enqueueSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/__tests__/projects-chat-api.test.ts`  
Expected: FAIL (route missing)

- [ ] **Step 3: Implement `src/app/api/projects/chat/route.ts`**

Implement:
- Origin/auth validation.
- TOCTOU realpath verification.
- Per-request tool factory integration (`createProjectHarnessTools`).
- Project prompt synthesis.
- Stream creation via AI SDK v7 `streamText` and `toUIMessageStream`.
- HMAC tool approval validation for destructive operations.
- Direct message saving into `project_messages` and `project_sessions`.
- Explicit omission of `ingest_turn` background job.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/__tests__/projects-chat-api.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/projects/chat/route.ts src/app/api/__tests__/projects-chat-api.test.ts
git commit -m "feat(projects): implement project harness chat API route with stream publishing and zero memory leakage"
```

---

### Task 7: Frontend Projects Hub & App Shell Integration

**Files:**
- Create: `src/components/projects/ProjectsList.tsx`
- Create: `src/components/projects/NewProjectDialog.tsx`
- Create: `src/components/projects/ImportProjectDialog.tsx`
- Modify: `src/components/sidebar.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/components/projects/__tests__/ProjectsList.test.tsx`

**Interfaces:**
- Consumes: `/api/projects` endpoints
- Produces: Projects Hub UI, sidebar menu item ("Projects"), AppShell view routing

- [ ] **Step 1: Write failing component test for ProjectsList**

```tsx
// src/components/projects/__tests__/ProjectsList.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectsList } from "../ProjectsList";

describe("ProjectsList", () => {
  it("renders projects list and displays trust badges", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "proj_1",
          name: "My Web App",
          directoryPath: "/home/user/web-app",
          trusted: true,
          existsOnDisk: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: "proj_2",
          name: "External Tool",
          directoryPath: "/home/user/tool",
          trusted: false,
          existsOnDisk: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    } as any);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
      expect(screen.getByText("External Tool")).toBeInTheDocument();
      expect(screen.getByText("Trusted")).toBeInTheDocument();
      expect(screen.getByText(/restricted/i)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/projects/__tests__/ProjectsList.test.tsx`  
Expected: FAIL (components missing)

- [ ] **Step 3: Implement `ProjectsList`, creation dialogs, and wire into `sidebar.tsx` and `page.tsx`**

Implement:
- `ProjectsList.tsx`: grid of projects, trust status badges, disk status, creation triggers.
- `NewProjectDialog.tsx`: sanitized name input, creates in `data/projects/`.
- `ImportProjectDialog.tsx`: local path input with trust explanation.
- Add "Projects" icon button to `src/components/sidebar.tsx`.
- Add `"projects"` view state to `src/app/page.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/projects/__tests__/ProjectsList.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/projects/ src/components/sidebar.tsx src/app/page.tsx
git commit -m "feat(ui): add projects hub, creation dialogs, and sidebar navigation"
```

---

### Task 8: Frontend Project Workspace View

**Files:**
- Create: `src/components/projects/ProjectWorkspace.tsx`
- Create: `src/components/projects/ProjectFileTree.tsx`
- Create: `src/components/projects/ProjectTrustBanner.tsx`
- Modify: `src/app/page.tsx`
- Test: `src/components/projects/__tests__/ProjectWorkspace.test.tsx`

**Interfaces:**
- Consumes: StoredProject, sessions API, `/api/projects/chat`, Yggdrasil chat components (`ChatMessageRow`, `PromptInput`, `TaskList`, `Reasoning`)
- Produces: Full interactive coding harness workspace

- [ ] **Step 1: Write failing component test for ProjectWorkspace**

```tsx
// src/components/projects/__tests__/ProjectWorkspace.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectWorkspace } from "../ProjectWorkspace";

describe("ProjectWorkspace", () => {
  it("renders ambient trust banner when project is untrusted", async () => {
    const project = {
      id: "proj_untrusted",
      name: "Untrusted Project",
      directoryPath: "/tmp/untrusted",
      trusted: false,
      isCustomDirectory: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    vi.spyOn(global, "fetch").mockImplementation(async (url: any) => {
      if (String(url).includes("/sessions")) {
        return { ok: true, json: async () => [] } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    });

    render(<ProjectWorkspace project={project} onBack={() => {}} onProjectUpdated={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/directory trust required/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /approve trust/i })).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/projects/__tests__/ProjectWorkspace.test.tsx`  
Expected: FAIL (components missing)

- [ ] **Step 3: Implement `ProjectWorkspace`, `ProjectFileTree`, and `ProjectTrustBanner`**

Implement:
- `ProjectWorkspace.tsx`:
  - Left rail: Session list, `+ New Session`, back button.
  - Ambient banner: Displays warning and one-click "Approve Trust" button when untrusted.
  - Center: Streaming chat using AI SDK `useChat` pointed to `/api/projects/chat`, rendering `ChatMessageRow`, `<Reasoning>`, `<ToolInvocation>`, and `PromptInput`.
  - Right drawer: `ProjectFileTree.tsx` for exploring project files with line viewer.
- Wire into `src/app/page.tsx` when a project is selected.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/projects/__tests__/ProjectWorkspace.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/projects/ProjectWorkspace.tsx src/components/projects/ProjectFileTree.tsx src/components/projects/ProjectTrustBanner.tsx src/app/page.tsx src/components/projects/__tests__/ProjectWorkspace.test.tsx
git commit -m "feat(ui): implement project workspace with chat harness, trust banner, and file explorer"
```

---

### Task 9: End-to-End Verification & Quality Gates

**Files:**
- Test: `src/app/api/__tests__/projects-e2e.test.ts`

**Interfaces:**
- Consumes: Full stack projects workflow
- Produces: Verification evidence for complete system

- [ ] **Step 1: Write comprehensive end-to-end integration test**

Verify:
1. Creating a new project (`scaffolded`) and an existing project (`untrusted`).
2. Creating sessions with distinct `psess_` IDs.
3. Pre-Trust restriction: untrusted project reads files but fails on write and bash.
4. Trust approval: POST `/api/projects/[id]/trust` succeeds and enables write and bash.
5. Verifying zero memory leakage: inspecting `job_queue` to ensure zero `ingest_turn` jobs.
6. Cascade delete: deleting project cleans up all sessions and messages.

- [ ] **Step 2: Run all project test suites sequentially**

Run: `pnpm vitest run src/db/__tests__/projects-schema.test.ts src/lib/__tests__/project-service.test.ts src/lib/__tests__/project-harness-tools.test.ts src/lib/ai/__tests__/project-prompt.test.ts src/app/api/__tests__/projects-api.test.ts src/app/api/__tests__/projects-chat-api.test.ts src/components/projects/__tests__/ProjectsList.test.tsx src/components/projects/__tests__/ProjectWorkspace.test.tsx src/app/api/__tests__/projects-e2e.test.ts`  
Expected: ALL PASS

- [ ] **Step 3: Run project-wide type checking and lint**

Run: `pnpm lint`  
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/__tests__/projects-e2e.test.ts
git commit -m "test(projects): add end-to-end integration test suite and verify quality gates"
```
