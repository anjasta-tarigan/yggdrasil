import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppDatabase } from "@/db";
import * as schema from "@/db/schema";
import {
  sanitizeProjectName,
  resolveCanonicalProjectPath,
  createProject,
  getProject,
  listProjects,
  listProjectsPaginated,
  updateProject,
  setProjectTrusted,
  deleteProject,
  deleteProjects,
  saveProjectSession,
  getProjectSession,
  listProjectSessions,
  deleteProjectSession,
  claimProjectSessionStream,
  releaseProjectSessionStream,
  type StoredProject,
} from "../project-service";

describe("Project Service", () => {
  let testDir: string;
  let sqlite: Database.Database;
  let testDb: AppDatabase;

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
    testDb = drizzle(sqlite, { schema }) as unknown as AppDatabase;
  });

  describe("sanitizeProjectName", () => {
    it("sanitizes valid project names and rejects path traversal sequences", () => {
      expect(sanitizeProjectName("My Awesome App")).toBe("my-awesome-app");
      expect(sanitizeProjectName("web_service-2026")).toBe("web_service-2026");

      expect(() => sanitizeProjectName("../../../etc/passwd")).toThrow();
      expect(() => sanitizeProjectName("foo/bar")).toThrow();
      expect(() => sanitizeProjectName("con")).toThrow();
      expect(() => sanitizeProjectName("")).toThrow();
    });

    it("handles whitespace, trims, lowercases, and collapses hyphens", () => {
      expect(sanitizeProjectName("  Hello   World  ")).toBe("hello-world");
      expect(sanitizeProjectName("foo---bar")).toBe("foo-bar");
      expect(sanitizeProjectName("Cool_Project-v2")).toBe("cool_project-v2");
    });

    it("rejects path traversal with backslashes and relative dots", () => {
      expect(() => sanitizeProjectName("..")).toThrow();
      expect(() => sanitizeProjectName("..\\windows\\system32")).toThrow();
      expect(() => sanitizeProjectName("a/b/c")).toThrow();
    });

    it("rejects all reserved OS filenames", () => {
      const reserved = [
        "con", "prn", "aux", "nul",
        "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
        "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
        "CON", "Prn", "NUL",
      ];
      for (const name of reserved) {
        expect(() => sanitizeProjectName(name)).toThrow();
      }
    });

    it("rejects names exceeding 64 characters and empty strings", () => {
      expect(() => sanitizeProjectName("")).toThrow();
      expect(() => sanitizeProjectName("   ")).toThrow();
      expect(() => sanitizeProjectName("a".repeat(65))).toThrow();
      expect(sanitizeProjectName("a".repeat(64))).toBe("a".repeat(64));
    });
  });

  describe("resolveCanonicalProjectPath (TOCTOU guard)", () => {
    it("resolves canonical project path and detects missing directories (TOCTOU guard)", async () => {
      const canonical = await resolveCanonicalProjectPath(testDir);
      expect(canonical).toBe(await fs.realpath(testDir));

      await expect(
        resolveCanonicalProjectPath(path.join(testDir, "non_existent_folder"))
      ).rejects.toThrow(/does not exist/);
    });

    it("rejects file paths that are not directories", async () => {
      const filePath = path.join(testDir, "test-file.txt");
      await fs.writeFile(filePath, "sample");
      await expect(resolveCanonicalProjectPath(filePath)).rejects.toThrow(/not a directory|does not exist/);
    });
  });

  describe("createProject", () => {
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
      const gitignoreContent = await fs.readFile(path.join(proj.directoryPath, ".gitignore"), "utf8");
      expect(gitignoreContent).toContain("node_modules");
    });

    it("does not overwrite existing AGENTS.md if already present", async () => {
      const targetDir = path.join(testDir, "existing-agents");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "AGENTS.md"), "# Custom Agents Content");

      const proj = await createProject(
        {
          name: "existing-agents",
          mode: "new",
          customBaseDir: testDir,
        },
        testDb
      );

      const agentsContent = await fs.readFile(path.join(proj.directoryPath, "AGENTS.md"), "utf8");
      expect(agentsContent).toBe("# Custom Agents Content");
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
      expect(proj.isCustomDirectory).toBe(true);

      const trusted = await setProjectTrusted(proj.id, true, testDb);
      expect(trusted?.trusted).toBe(true);
      expect(trusted?.trustedAt).toBeDefined();

      const untrusted = await setProjectTrusted(proj.id, false, testDb);
      expect(untrusted?.trusted).toBe(false);
      expect(untrusted?.trustedAt).toBeNull();
    });

    it("rejects existing project mode if directory does not exist", async () => {
      await expect(
        createProject(
          {
            name: "Missing Directory App",
            directoryPath: path.join(testDir, "missing-dir"),
            mode: "existing",
          },
          testDb
        )
      ).rejects.toThrow(/does not exist/);
    });
  });

  describe("Project CRUD", () => {
    it("lists, gets, updates, and deletes projects", async () => {
      const proj = await createProject(
        {
          name: "crud-test",
          description: "Initial description",
          mode: "new",
          customBaseDir: testDir,
        },
        testDb
      );

      const retrieved = await getProject(proj.id, testDb);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(proj.id);
      expect(retrieved?.description).toBe("Initial description");

      const updated = await updateProject(
        proj.id,
        {
          name: "crud-test-updated",
          description: "Updated description",
          customInstructions: "Follow strict TypeScript",
        },
        testDb
      );
      expect(updated?.name).toBe("crud-test-updated");
      expect(updated?.description).toBe("Updated description");
      expect(updated?.customInstructions).toBe("Follow strict TypeScript");

      const list = await listProjects(testDb);
      expect(list.some((p: StoredProject) => p.id === proj.id)).toBe(true);

      await deleteProject(proj.id, testDb);
      const afterDelete = await getProject(proj.id, testDb);
      expect(afterDelete).toBeNull();
    });
  });

  describe("Stream claim reconciliation (stale active_stream_id)", () => {
    async function seedSession(projectName: string, sessionId: string) {
      const proj = await createProject(
        { name: projectName, mode: "new", customBaseDir: testDir },
        testDb
      );
      await saveProjectSession(
        {
          id: sessionId,
          projectId: proj.id,
          title: "Stream session",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        },
        testDb
      );
      return proj;
    }

    it("claims a free session", async () => {
      await seedSession("claim-free", "psess_claim_free");
      expect(claimProjectSessionStream("psess_claim_free", "stream_1", testDb)).toBe(true);
    });

    it("refuses a second claim while a live stream holds the session", async () => {
      await seedSession("claim-live", "psess_claim_live");
      expect(claimProjectSessionStream("psess_claim_live", "stream_1", testDb)).toBe(true);
      // Liveness predicate says the holder is live → 409.
      expect(
        claimProjectSessionStream("psess_claim_live", "stream_2", testDb, () => true)
      ).toBe(false);
      // The original claim is untouched.
      const session = await getProjectSession("psess_claim_live", testDb);
      expect(session?.activeStreamId).toBe("stream_1");
    });

    it("reconciles a stale pointer after a restart so the session is usable again", async () => {
      await seedSession("claim-stale", "psess_claim_stale");
      // Simulate a stream that ran before a restart: the row keeps the id,
      // but the in-process registry no longer knows it.
      expect(claimProjectSessionStream("psess_claim_stale", "stream_old", testDb)).toBe(true);

      // A dead pointer must not block a fresh send.
      const claimed = claimProjectSessionStream(
        "psess_claim_stale",
        "stream_new",
        testDb,
        () => false
      );
      expect(claimed).toBe(true);

      const session = await getProjectSession("psess_claim_stale", testDb);
      expect(session?.activeStreamId).toBe("stream_new");
    });

    it("release only clears a pointer it still owns", async () => {
      await seedSession("claim-release", "psess_claim_release");
      claimProjectSessionStream("psess_claim_release", "stream_a", testDb);

      // A newer stream took over: the old release must not clobber it.
      expect(releaseProjectSessionStream("psess_claim_release", "stream_old", testDb)).toBe(false);
      expect((await getProjectSession("psess_claim_release", testDb))?.activeStreamId).toBe("stream_a");

      expect(releaseProjectSessionStream("psess_claim_release", "stream_a", testDb)).toBe(true);
      expect((await getProjectSession("psess_claim_release", testDb))?.activeStreamId).toBeNull();
    });
  });

  describe("Project Sessions & Messages", () => {
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

    it("lists sessions and avoids N+1 queries using batch loading", async () => {
      const proj = await createProject(
        { name: "batch-list-test", mode: "new", customBaseDir: testDir },
        testDb
      );

      await saveProjectSession(
        {
          id: "psess_a",
          projectId: proj.id,
          title: "Session A",
          createdAt: 1000,
          updatedAt: 2000,
          messages: [
            {
              id: "pmsg_a1",
              role: "user",
              parts: [{ type: "text", text: "Message A1" }],
            },
            {
              id: "pmsg_a2",
              role: "assistant",
              parts: [{ type: "text", text: "Response A2" }],
            },
          ],
        },
        testDb
      );

      await saveProjectSession(
        {
          id: "psess_b",
          projectId: proj.id,
          title: "Session B",
          createdAt: 1000,
          updatedAt: 3000,
          messages: [
            {
              id: "pmsg_b1",
              role: "user",
              parts: [{ type: "text", text: "Message B1" }],
            },
          ],
        },
        testDb
      );

      const sessions = await listProjectSessions(proj.id, testDb);
      expect(sessions.length).toBe(2);
      expect(sessions[0].id).toBe("psess_b"); // sorted by updatedAt desc
      expect(sessions[0].messages.length).toBe(1);
      expect(sessions[1].id).toBe("psess_a");
      expect(sessions[1].messages.length).toBe(2);
    });

    it("updates existing session and syncs messages in transaction", async () => {
      const proj = await createProject(
        { name: "sync-test", mode: "new", customBaseDir: testDir },
        testDb
      );

      await saveProjectSession(
        {
          id: "psess_sync",
          projectId: proj.id,
          title: "Original Title",
          createdAt: 1000,
          updatedAt: 1000,
          messages: [
            {
              id: "pmsg_s1",
              role: "user",
              parts: [{ type: "text", text: "Keep this" }],
            },
            {
              id: "pmsg_s2",
              role: "assistant",
              parts: [{ type: "text", text: "Delete this in next save" }],
            },
          ],
        },
        testDb
      );

      // Now save with updated title, pmsg_s2 removed, and pmsg_s3 added
      await saveProjectSession(
        {
          id: "psess_sync",
          projectId: proj.id,
          title: "Updated Title",
          createdAt: 1000,
          updatedAt: 2000,
          messages: [
            {
              id: "pmsg_s1",
              role: "user",
              parts: [{ type: "text", text: "Keep this (edited)" }],
            },
            {
              id: "pmsg_s3",
              role: "assistant",
              parts: [{ type: "text", text: "New message" }],
            },
          ],
        },
        testDb
      );

      const reloaded = await getProjectSession("psess_sync", testDb);
      expect(reloaded?.title).toBe("Updated Title");
      expect(reloaded?.messages.length).toBe(2);
      expect(reloaded?.messages[0].id).toBe("pmsg_s1");
      expect(reloaded?.messages[0].parts[0]).toEqual({ type: "text", text: "Keep this (edited)" });
      expect(reloaded?.messages[1].id).toBe("pmsg_s3");
    });

    it("deletes a project session and cascades cleanup", async () => {
      const proj = await createProject(
        { name: "del-sess-test", mode: "new", customBaseDir: testDir },
        testDb
      );

      await saveProjectSession(
        {
          id: "psess_del",
          projectId: proj.id,
          title: "To Delete",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [
            {
              id: "pmsg_del_1",
              role: "user",
              parts: [{ type: "text", text: "Will be deleted" }],
            },
          ],
        },
        testDb
      );

      await deleteProjectSession("psess_del", testDb);
      const retrieved = await getProjectSession("psess_del", testDb);
      expect(retrieved).toBeNull();
    });
  });

  describe("Memory Isolation Invariant", () => {
    it("contains zero references to cognitive memories in project service", async () => {
      const serviceModulePath = path.resolve(__dirname, "../project-service.ts");
      const content = await fs.readFile(serviceModulePath, "utf8");

      expect(content).not.toContain("semanticMemories");
      expect(content).not.toContain("episodicMemories");
      expect(content).not.toContain("workingMemory");
      expect(content).not.toContain("hybridMemorySearch");
    });
  });

  describe("listProjectsPaginated", () => {
    it("returns paginated results with correct metadata", async () => {
      // Create 5 projects
      for (let i = 0; i < 5; i++) {
        await createProject(
          { name: `paginated-svc-${i}`, mode: "new", customBaseDir: testDir },
          testDb
        );
      }

      const result = await listProjectsPaginated(1, 2, testDb);
      expect(result.projects.length).toBe(2);
      expect(result.total).toBe(5);
      expect(result.totalPages).toBe(3);
      expect(result.hasMore).toBe(true);
      expect(result.hasPrev).toBe(false);
    });

    it("returns last page with hasMore=false", async () => {
      for (let i = 0; i < 5; i++) {
        await createProject(
          { name: `paginated-last-${i}`, mode: "new", customBaseDir: testDir },
          testDb
        );
      }

      const result = await listProjectsPaginated(3, 2, testDb);
      expect(result.projects.length).toBe(1);
      expect(result.total).toBe(5);
      expect(result.totalPages).toBe(3);
      expect(result.hasMore).toBe(false);
      expect(result.hasPrev).toBe(true);
    });

    it("clamps limit to max 100 and normalizes page to minimum 1", async () => {
      await createProject(
        { name: "pagination-clamp", mode: "new", customBaseDir: testDir },
        testDb
      );

      // Page 0 should be treated as page 1
      const result = await listProjectsPaginated(0, 100, testDb);
      expect(result.projects.length).toBe(1);
      expect(result.hasMore).toBe(false);
    });

    it("returns empty result when no projects exist", async () => {
      const result = await listProjectsPaginated(1, 20, testDb);
      expect(result.projects.length).toBe(0);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(result.hasPrev).toBe(false);
    });
  });

  describe("deleteProjects", () => {
    it("bulk deletes multiple projects with their sessions and messages", async () => {
      const proj1 = await createProject(
        { name: "bulk-del-1", mode: "new", customBaseDir: testDir },
        testDb
      );
      const proj2 = await createProject(
        { name: "bulk-del-2", mode: "new", customBaseDir: testDir },
        testDb
      );

      // Create a session + message for proj1 so we can verify cascade
      const { saveProjectSession } = await import("../project-service");
      await saveProjectSession(
        {
          id: "psess_bulk_test_1",
          projectId: proj1.id,
          title: "Test Session",
          pinned: false,
          messages: [],
        },
        testDb
      );

      await deleteProjects([proj1.id, proj2.id], testDb);

      const listRes = await listProjects(testDb);
      expect(listRes.find((p) => p.id === proj1.id)).toBeUndefined();
      expect(listRes.find((p) => p.id === proj2.id)).toBeUndefined();

      // Verify sessions were cascade-deleted
      const { listProjectSessions } = await import("../project-service");
      const sessions = await listProjectSessions(proj1.id, testDb);
      expect(sessions.length).toBe(0);
    });

    it("is a no-op when called with empty array", async () => {
      await expect(deleteProjects([], testDb)).resolves.not.toThrow();
    });
  });
});
