import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GET as listProjectsGet, POST as createProjectPost } from "../projects/route";
import { DELETE as deleteProjectDelete } from "../projects/[id]/route";
import { POST as trustProjectPost } from "../projects/[id]/trust/route";
import { POST as createSessionPost } from "../projects/[id]/sessions/route";
import { POST as chatPost } from "../projects/chat/route";
import { createProjectHarnessTools } from "@/lib/project-harness-tools";
import {
  deleteProject,
  saveProjectSession,
  type StoredProject,
  type StoredProjectSession,
} from "@/lib/project-service";
import * as queue from "@/lib/queue/queue";
import { resetStreamRegistry } from "@/lib/ai/stream-registry";
import { db } from "@/db";
import {
  projects,
  projectSessions,
  projectMessages,
  jobQueue,
  chatMessages,
  episodicMemories,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

describe("Projects End-to-End Integration Suite", () => {
  let testDir: string;
  const createdProjectIds: string[] = [];

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-e2e-test-"));
    resetStreamRegistry();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetStreamRegistry();
    for (const id of createdProjectIds) {
      try {
        await deleteProject(id);
      } catch {
        // ignore cleanup error
      }
    }
    createdProjectIds.length = 0;
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  it("1. verifies project creation, auto-scaffolding, and initial trust flags for new & existing modes", async () => {
    // 1a. Create a 'new' project in Yggdrasil-managed directory
    const newReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "scaffolded-api-proj",
        mode: "new",
        description: "Scaffolded test workspace",
        customBaseDir: testDir,
      }),
    });

    const newRes = await createProjectPost(newReq);
    expect(newRes.status).toBe(201);
    const newProj = (await newRes.json()) as StoredProject;
    createdProjectIds.push(newProj.id);

    expect(newProj.id).toMatch(/^proj_/);
    expect(newProj.name).toBe("scaffolded-api-proj");
    expect(newProj.trusted).toBe(true);
    expect(newProj.isCustomDirectory).toBe(false);
    expect(newProj.directoryPath).toContain("scaffolded-api-proj");

    // Verify auto-scaffolded files on disk
    const agentsContent = await fs.readFile(
      path.join(newProj.directoryPath, "AGENTS.md"),
      "utf8"
    );
    expect(agentsContent).toContain("scaffolded-api-proj");

    const claudeContent = await fs.readFile(
      path.join(newProj.directoryPath, "CLAUDE.md"),
      "utf8"
    );
    expect(claudeContent).toContain("@AGENTS.md");

    const gitignoreContent = await fs.readFile(
      path.join(newProj.directoryPath, ".gitignore"),
      "utf8"
    );
    expect(gitignoreContent).toContain("node_modules/");

    // 1b. Create an 'existing' project pointing to an external directory
    const externalDir = path.join(testDir, "external-source");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "server.ts"),
      "export const server = { port: 8080 };"
    );
    await fs.writeFile(
      path.join(externalDir, "README.md"),
      "# External Untrusted Project"
    );

    const existingReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "external-untrusted-proj",
        mode: "existing",
        directoryPath: externalDir,
        description: "External pre-existing code",
      }),
    });

    const existingRes = await createProjectPost(existingReq);
    expect(existingRes.status).toBe(201);
    const untrustedProj = (await existingRes.json()) as StoredProject;
    createdProjectIds.push(untrustedProj.id);

    expect(untrustedProj.id).toMatch(/^proj_/);
    expect(untrustedProj.name).toBe("external-untrusted-proj");
    expect(untrustedProj.trusted).toBe(false);
    expect(untrustedProj.isCustomDirectory).toBe(true);

    // Verify existing files were preserved without being overwritten
    const preservedServer = await fs.readFile(
      path.join(externalDir, "server.ts"),
      "utf8"
    );
    expect(preservedServer).toBe("export const server = { port: 8080 };");

    // 1c. List projects endpoint returns both projects
    const listRes = await listProjectsGet(
      new Request("http://localhost:3000/api/projects", {
        headers: { Origin: "http://localhost:3000" },
      })
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as StoredProject[];
    expect(list.some((p) => p.id === newProj.id)).toBe(true);
    expect(list.some((p) => p.id === untrustedProj.id)).toBe(true);
  });

  it("2. verifies session lifecycle and distinct psess_ ID prefix strictly scoped to project", async () => {
    // Create scaffolded project
    const projRes = await createProjectPost(
      new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "session-test-proj",
          mode: "new",
          customBaseDir: testDir,
        }),
      })
    );
    const proj = (await projRes.json()) as StoredProject;
    createdProjectIds.push(proj.id);

    // Create session 1
    const sess1Res = await createSessionPost(
      new Request(`http://localhost:3000/api/projects/${proj.id}/sessions`, {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Session Architecture" }),
      }),
      { params: Promise.resolve({ id: proj.id }) }
    );
    expect(sess1Res.status).toBe(201);
    const sess1 = (await sess1Res.json()) as StoredProjectSession;

    // Create session 2
    const sess2Res = await createSessionPost(
      new Request(`http://localhost:3000/api/projects/${proj.id}/sessions`, {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Session Implementation" }),
      }),
      { params: Promise.resolve({ id: proj.id }) }
    );
    expect(sess2Res.status).toBe(201);
    const sess2 = (await sess2Res.json()) as StoredProjectSession;

    // Verify distinct IDs beginning with psess_ prefix
    expect(sess1.id).toMatch(/^psess_/);
    expect(sess2.id).toMatch(/^psess_/);
    expect(sess1.id).not.toBe(sess2.id);

    // Verify project scoping
    expect(sess1.projectId).toBe(proj.id);
    expect(sess2.projectId).toBe(proj.id);
    expect(sess1.title).toBe("Session Architecture");
    expect(sess2.title).toBe("Session Implementation");

    // Verify records exist in SQLite projectSessions table
    const dbSessions = await db
      .select()
      .from(projectSessions)
      .where(inArray(projectSessions.id, [sess1.id, sess2.id]));
    expect(dbSessions).toHaveLength(2);
    expect(dbSessions.every((s) => s.projectId === proj.id)).toBe(true);
  });

  it("3. verifies pre-trust restriction matrix: read/list/find/grep allowed, write/edit/bash blocked with exitCode 126", async () => {
    // Setup external untrusted workspace
    const externalDir = path.join(testDir, "pre-trust-workspace");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "main.ts"),
      "export const appConfig = { status: 'untrusted_active' };"
    );
    await fs.writeFile(
      path.join(externalDir, "metadata.json"),
      JSON.stringify({ version: "1.0.0" })
    );

    const projRes = await createProjectPost(
      new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "pre-trust-proj",
          mode: "existing",
          directoryPath: externalDir,
        }),
      })
    );
    const untrustedProj = (await projRes.json()) as StoredProject;
    createdProjectIds.push(untrustedProj.id);
    expect(untrustedProj.trusted).toBe(false);

    const canonicalRoot = await fs.realpath(untrustedProj.directoryPath);
    const untrustedTools = createProjectHarnessTools({
      projectDirectory: untrustedProj.directoryPath,
      canonicalRoot,
      trusted: false,
    });

    // 3a. file_operations: read is permitted
    const readResult = await untrustedTools.file_operations.execute({
      action: "read",
      path: "main.ts",
    });
    expect(readResult.content).toContain("untrusted_active");

    // 3b. file_operations: list is permitted
    const listResult = await untrustedTools.file_operations.execute({
      action: "list",
      path: ".",
    });
    expect(listResult.listing).toBeDefined();
    expect(listResult.listing).toContain("main.ts");
    expect(listResult.listing).toContain("metadata.json");

    // 3c. file_operations: find is permitted
    const findResult = await untrustedTools.file_operations.execute({
      action: "find",
      pattern: "*.ts",
    });
    expect(findResult.matches).toBeDefined();
    expect(findResult.matches?.some((m) => m.includes("main.ts"))).toBe(true);

    // 3d. file_operations: grep is permitted
    const grepResult = await untrustedTools.file_operations.execute({
      action: "grep",
      query: "untrusted_active",
    });
    expect(grepResult.matches).toBeDefined();
    expect(grepResult.matches?.length).toBeGreaterThanOrEqual(1);

    // 3e. file_operations: write is BLOCKED with structured error
    const writeResult = await untrustedTools.file_operations.execute({
      action: "write",
      path: "unauthorized.ts",
      content: "malicious code injection",
    });
    expect(writeResult.error).toBe(
      "Directory trust required to modify files. Please approve directory trust in the project view before modifying files."
    );
    await expect(
      fs.access(path.join(externalDir, "unauthorized.ts"))
    ).rejects.toThrow();

    // 3f. file_operations: edit is BLOCKED with structured error
    const editResult = await untrustedTools.file_operations.execute({
      action: "edit",
      path: "main.ts",
      oldString: "untrusted_active",
      newString: "hacked",
    });
    expect(editResult.error).toBe(
      "Directory trust required to modify files. Please approve directory trust in the project view before modifying files."
    );
    const untouchedMain = await fs.readFile(
      path.join(externalDir, "main.ts"),
      "utf8"
    );
    expect(untouchedMain).toContain("untrusted_active");

    // 3g. bash is BLOCKED with structured error and exitCode 126
    const bashResult = await untrustedTools.bash.execute({
      command: "echo 'injected command'",
    });
    expect(bashResult.exitCode).toBe(126);
    expect(bashResult.stderr).toBe(
      "Directory trust required to execute shell commands. Please approve directory trust in the project view before running terminal commands."
    );
  });

  it("4. verifies trust transition via POST /api/projects/[id]/trust and tool activation", async () => {
    const externalDir = path.join(testDir, "transition-workspace");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "entry.ts"),
      "export const state = 'initial';"
    );

    const projRes = await createProjectPost(
      new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "transition-proj",
          mode: "existing",
          directoryPath: externalDir,
        }),
      })
    );
    const proj = (await projRes.json()) as StoredProject;
    createdProjectIds.push(proj.id);
    expect(proj.trusted).toBe(false);

    // Call trust endpoint to approve directory trust
    const trustRes = await trustProjectPost(
      new Request(`http://localhost:3000/api/projects/${proj.id}/trust`, {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ trusted: true }),
      }),
      { params: Promise.resolve({ id: proj.id }) }
    );
    expect(trustRes.status).toBe(200);
    const trustedProj = (await trustRes.json()) as StoredProject;
    expect(trustedProj.trusted).toBe(true);
    expect(trustedProj.trustedAt).toBeTruthy();

    // Verify DB update
    const [dbProj] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, proj.id));
    expect(Boolean(dbProj.trusted)).toBe(true);

    // Verify harness tools now allow write, edit, and bash
    const canonicalRoot = await fs.realpath(proj.directoryPath);
    const activatedTools = createProjectHarnessTools({
      projectDirectory: proj.directoryPath,
      canonicalRoot,
      trusted: true,
    });

    // Write works
    const writeRes = await activatedTools.file_operations.execute({
      action: "write",
      path: "trusted-script.ts",
      content: "export const trusted = true;",
    });
    expect(writeRes.status).toBe("success");
    const writtenFile = await fs.readFile(
      path.join(externalDir, "trusted-script.ts"),
      "utf8"
    );
    expect(writtenFile).toBe("export const trusted = true;");

    // Edit works
    const editRes = await activatedTools.file_operations.execute({
      action: "edit",
      path: "entry.ts",
      oldString: "initial",
      newString: "trusted_ready",
    });
    expect(editRes.status).toBe("success");
    expect(editRes.replaced).toBe(true);
    const editedFile = await fs.readFile(
      path.join(externalDir, "entry.ts"),
      "utf8"
    );
    expect(editedFile).toContain("trusted_ready");

    // Bash works
    const bashRes = await activatedTools.bash.execute({
      command: "echo 'e2e-trust-activated'",
    });
    expect(bashRes.exitCode).toBe(0);
    expect(bashRes.stdout.trim()).toBe("e2e-trust-activated");
  });

  it(
    "5. verifies zero memory leakage invariant (no ingest_turn queue jobs, no regular memory pollution)",
    async () => {
      const projRes = await createProjectPost(
        new Request("http://localhost:3000/api/projects", {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "memory-leak-test-proj",
            mode: "new",
            customBaseDir: testDir,
          }),
        })
      );
      const proj = (await projRes.json()) as StoredProject;
      createdProjectIds.push(proj.id);

      const sessRes = await createSessionPost(
        new Request(`http://localhost:3000/api/projects/${proj.id}/sessions`, {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: "Memory Leak Check Session" }),
        }),
        { params: Promise.resolve({ id: proj.id }) }
      );
      const session = (await sessRes.json()) as StoredProjectSession;

      const enqueueSpy = vi.spyOn(queue, "enqueueJob");

      const chatReq = new Request("http://localhost:3000/api/projects/chat", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: proj.id,
          sessionId: session.id,
          effort: "medium",
          messages: [
            {
              role: "user",
              parts: [{ type: "text", text: "Explain files in workspace" }],
            },
          ],
        }),
      });

      const chatRes = await chatPost(chatReq);
      expect(chatRes.status).toBe(200);

      // Consume stream completely
      const reader = chatRes.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      // Allow onEnd stream persistence to finish
      await new Promise((r) => setTimeout(r, 150));

      // Invariant A: enqueueJob was never called with ingest_turn
      const ingestJobCalls = enqueueSpy.mock.calls.filter(
        ([job]) => job.type === "ingest_turn"
      );
      expect(ingestJobCalls).toHaveLength(0);

      // Invariant B: job_queue table has NO ingest_turn jobs for this project session
      const allJobs = await db.select().from(jobQueue);
      const sessionIngestJobs = allJobs.filter((j) => {
        if (j.type === "ingest_turn") {
          try {
            const payload =
              typeof j.payload === "string"
                ? (JSON.parse(j.payload) as Record<string, unknown>)
                : (j.payload as Record<string, unknown>);
            return payload?.sessionId === session.id;
          } catch {
            return false;
          }
        }
        return false;
      });
      expect(sessionIngestJobs).toHaveLength(0);

      // Invariant C: Regular chat memory tables contain NO rows for this project session
      const regularChatMsgs = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, session.id));
      expect(regularChatMsgs).toHaveLength(0);

      const regularEpisodicMems = await db
        .select()
        .from(episodicMemories)
        .where(eq(episodicMemories.sessionId, session.id));
      expect(regularEpisodicMems).toHaveLength(0);

      // Invariant D: Project chat messages ARE stored in projectMessages table
      const storedProjMsgs = await db
        .select()
        .from(projectMessages)
        .where(eq(projectMessages.sessionId, session.id));
      expect(storedProjMsgs.length).toBeGreaterThanOrEqual(1);

      enqueueSpy.mockRestore();
    },
    60_000
  );

  it("6. verifies cascade delete cleans DB records while preserving custom directory on disk", async () => {
    // 6a. Create existing custom project with disk files
    const externalDir = path.join(testDir, "external-preserve");
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(
      path.join(externalDir, "source.ts"),
      "export const originalCode = true;"
    );

    const customRes = await createProjectPost(
      new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "custom-preserve-proj",
          mode: "existing",
          directoryPath: externalDir,
        }),
      })
    );
    const customProj = (await customRes.json()) as StoredProject;
    createdProjectIds.push(customProj.id);

    // Create session & messages in custom project
    const customSessRes = await createSessionPost(
      new Request(`http://localhost:3000/api/projects/${customProj.id}/sessions`, {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Custom Session" }),
      }),
      { params: Promise.resolve({ id: customProj.id }) }
    );
    const customSess = (await customSessRes.json()) as StoredProjectSession;

    await saveProjectSession({
      id: customSess.id,
      projectId: customProj.id,
      title: customSess.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeStreamId: null,
      messages: [
        {
          id: `pmsg_${Date.now()}_1`,
          role: "user",
          parts: [{ type: "text", text: "Hello custom project" }],
        },
        {
          id: `pmsg_${Date.now()}_2`,
          role: "assistant",
          parts: [{ type: "text", text: "Hello! How can I help?" }],
        },
      ],
    });

    // 6b. Create new scaffolded project
    const newRes = await createProjectPost(
      new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "scaffold-delete-proj",
          mode: "new",
          customBaseDir: testDir,
        }),
      })
    );
    const newProj = (await newRes.json()) as StoredProject;
    createdProjectIds.push(newProj.id);

    const newSessRes = await createSessionPost(
      new Request(`http://localhost:3000/api/projects/${newProj.id}/sessions`, {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Scaffold Session" }),
      }),
      { params: Promise.resolve({ id: newProj.id }) }
    );
    const newSess = (await newSessRes.json()) as StoredProjectSession;

    await saveProjectSession({
      id: newSess.id,
      projectId: newProj.id,
      title: newSess.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeStreamId: null,
      messages: [
        {
          id: `pmsg_${Date.now()}_3`,
          role: "user",
          parts: [{ type: "text", text: "Scaffold prompt" }],
        },
      ],
    });

    // Verify DB records exist prior to deletion
    const beforeSessions = await db
      .select()
      .from(projectSessions)
      .where(inArray(projectSessions.projectId, [customProj.id, newProj.id]));
    expect(beforeSessions).toHaveLength(2);

    // Delete custom project via DELETE route
    const delCustomRes = await deleteProjectDelete(
      new Request(`http://localhost:3000/api/projects/${customProj.id}`, {
        method: "DELETE",
        headers: { Origin: "http://localhost:3000" },
      }),
      { params: Promise.resolve({ id: customProj.id }) }
    );
    expect(delCustomRes.status).toBe(200);
    const delCustomJson = (await delCustomRes.json()) as { success: boolean };
    expect(delCustomJson.success).toBe(true);

    // Verify custom project DB cascade deletion
    const dbCustomProj = await db
      .select()
      .from(projects)
      .where(eq(projects.id, customProj.id));
    expect(dbCustomProj).toHaveLength(0);

    const dbCustomSess = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.projectId, customProj.id));
    expect(dbCustomSess).toHaveLength(0);

    const dbCustomMsgs = await db
      .select()
      .from(projectMessages)
      .where(eq(projectMessages.sessionId, customSess.id));
    expect(dbCustomMsgs).toHaveLength(0);

    // CRITICAL: External directory on disk MUST be preserved
    const externalStat = await fs.stat(externalDir);
    expect(externalStat.isDirectory()).toBe(true);
    const preservedFile = await fs.readFile(
      path.join(externalDir, "source.ts"),
      "utf8"
    );
    expect(preservedFile).toBe("export const originalCode = true;");

    // Delete scaffolded project via DELETE route
    const delNewRes = await deleteProjectDelete(
      new Request(`http://localhost:3000/api/projects/${newProj.id}`, {
        method: "DELETE",
        headers: { Origin: "http://localhost:3000" },
      }),
      { params: Promise.resolve({ id: newProj.id }) }
    );
    expect(delNewRes.status).toBe(200);

    // Verify new project DB cascade deletion
    const dbNewProj = await db
      .select()
      .from(projects)
      .where(eq(projects.id, newProj.id));
    expect(dbNewProj).toHaveLength(0);

    const dbNewSess = await db
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.projectId, newProj.id));
    expect(dbNewSess).toHaveLength(0);

    const dbNewMsgs = await db
      .select()
      .from(projectMessages)
      .where(eq(projectMessages.sessionId, newSess.id));
    expect(dbNewMsgs).toHaveLength(0);
  });

  it(
    "7. executes complete unbroken full-lifecycle project journey end-to-end",
    async () => {
      // Step A: Create existing untrusted project
      const lifecycleDir = path.join(testDir, "lifecycle-external");
      await fs.mkdir(lifecycleDir, { recursive: true });
      await fs.writeFile(
        path.join(lifecycleDir, "index.ts"),
        "export const version = '0.1.0';"
      );
      await fs.writeFile(
        path.join(lifecycleDir, "README.md"),
        "# Lifecycle External Test Project"
      );

      const createRes = await createProjectPost(
        new Request("http://localhost:3000/api/projects", {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "lifecycle-e2e-project",
            mode: "existing",
            directoryPath: lifecycleDir,
          }),
        })
      );
      expect(createRes.status).toBe(201);
      const proj = (await createRes.json()) as StoredProject;
      createdProjectIds.push(proj.id);
      expect(proj.trusted).toBe(false);
      expect(proj.isCustomDirectory).toBe(true);

      // Step B: Create session with distinct psess_ ID
      const sessRes = await createSessionPost(
        new Request(`http://localhost:3000/api/projects/${proj.id}/sessions`, {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: "Lifecycle Main Session" }),
        }),
        { params: Promise.resolve({ id: proj.id }) }
      );
      expect(sessRes.status).toBe(201);
      const session = (await sessRes.json()) as StoredProjectSession;
      expect(session.id).toMatch(/^psess_/);
      expect(session.projectId).toBe(proj.id);

      // Step C: Pre-Trust Restriction Check
      const canonicalRoot = await fs.realpath(proj.directoryPath);
      const preTrustTools = createProjectHarnessTools({
        projectDirectory: proj.directoryPath,
        canonicalRoot,
        trusted: false,
      });

      // Read allowed
      const readRes = await preTrustTools.file_operations.execute({
        action: "read",
        path: "index.ts",
      });
      expect(readRes.content).toContain("0.1.0");

      // Write blocked
      const writeBlocked = await preTrustTools.file_operations.execute({
        action: "write",
        path: "attack.ts",
        content: "denied",
      });
      expect(writeBlocked.error).toMatch(/Directory trust required/);

      // Bash blocked with exitCode 126
      const bashBlocked = await preTrustTools.bash.execute({
        command: "ls -la",
      });
      expect(bashBlocked.exitCode).toBe(126);
      expect(bashBlocked.stderr).toMatch(/Directory trust required/);

      // Step D: Trust Transition via POST /api/projects/[id]/trust
      const trustRes = await trustProjectPost(
        new Request(`http://localhost:3000/api/projects/${proj.id}/trust`, {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ trusted: true }),
        }),
        { params: Promise.resolve({ id: proj.id }) }
      );
      expect(trustRes.status).toBe(200);
      const trustData = (await trustRes.json()) as StoredProject;
      expect(trustData.trusted).toBe(true);

      // Post-trust tool activation
      const postTrustTools = createProjectHarnessTools({
        projectDirectory: proj.directoryPath,
        canonicalRoot,
        trusted: true,
      });

      const writeAllowed = await postTrustTools.file_operations.execute({
        action: "write",
        path: "feature.ts",
        content: "export const feature = 'active';",
      });
      expect(writeAllowed.status).toBe("success");

      const bashAllowed = await postTrustTools.bash.execute({
        command: "echo 'lifecycle-bash-ok'",
      });
      expect(bashAllowed.exitCode).toBe(0);
      expect(bashAllowed.stdout.trim()).toBe("lifecycle-bash-ok");

      // Step E: Chat & Zero Memory Leakage Invariant
      const enqueueSpy = vi.spyOn(queue, "enqueueJob");

      const chatRes = await chatPost(
        new Request("http://localhost:3000/api/projects/chat", {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectId: proj.id,
            sessionId: session.id,
            effort: "medium",
            messages: [
              {
                role: "user",
                parts: [{ type: "text", text: "Describe current workspace status." }],
              },
            ],
          }),
        })
      );
      expect(chatRes.status).toBe(200);

      const reader = chatRes.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }

      await new Promise((r) => setTimeout(r, 150));

      const ingestCalls = enqueueSpy.mock.calls.filter(
        ([job]) => job.type === "ingest_turn"
      );
      expect(ingestCalls).toHaveLength(0);

      const jobsInDb = await db.select().from(jobQueue);
      const sessionJobs = jobsInDb.filter((j) => {
        if (j.type === "ingest_turn") {
          try {
            const p =
              typeof j.payload === "string"
                ? (JSON.parse(j.payload) as Record<string, unknown>)
                : (j.payload as Record<string, unknown>);
            return p?.sessionId === session.id;
          } catch {
            return false;
          }
        }
        return false;
      });
      expect(sessionJobs).toHaveLength(0);

      // Confirm no leakage into regular chat memories
      const leakedChatMsgs = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, session.id));
      expect(leakedChatMsgs).toHaveLength(0);

      enqueueSpy.mockRestore();

      // Step F: Cascade Deletion & Disk Preservation
      const delRes = await deleteProjectDelete(
        new Request(`http://localhost:3000/api/projects/${proj.id}`, {
          method: "DELETE",
          headers: { Origin: "http://localhost:3000" },
        }),
        { params: Promise.resolve({ id: proj.id }) }
      );
      expect(delRes.status).toBe(200);

      // DB wiped
      const remainingProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.id, proj.id));
      expect(remainingProjects).toHaveLength(0);

      const remainingSessions = await db
        .select()
        .from(projectSessions)
        .where(eq(projectSessions.projectId, proj.id));
      expect(remainingSessions).toHaveLength(0);

      const remainingMessages = await db
        .select()
        .from(projectMessages)
        .where(eq(projectMessages.sessionId, session.id));
      expect(remainingMessages).toHaveLength(0);

      // Disk preserved
      const diskDirStat = await fs.stat(lifecycleDir);
      expect(diskDirStat.isDirectory()).toBe(true);

      const originalIndex = await fs.readFile(
        path.join(lifecycleDir, "index.ts"),
        "utf8"
      );
      expect(originalIndex).toBe("export const version = '0.1.0';");

      const createdFeature = await fs.readFile(
        path.join(lifecycleDir, "feature.ts"),
        "utf8"
      );
      expect(createdFeature).toBe("export const feature = 'active';");
    },
    60_000
  );
});
