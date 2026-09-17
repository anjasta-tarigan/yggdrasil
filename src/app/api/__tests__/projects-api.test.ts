import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GET as listProjectsGet, POST as createProjectPost } from "../projects/route";
import {
  GET as getProjectGet,
  PATCH as updateProjectPatch,
  DELETE as deleteProjectDelete,
} from "../projects/[id]/route";
import { POST as trustProjectPost } from "../projects/[id]/trust/route";
import { GET as getProjectFilesGet } from "../projects/[id]/files/route";
import {
  GET as listSessionsGet,
  POST as createSessionPost,
} from "../projects/[id]/sessions/route";
import {
  GET as getSessionGet,
  DELETE as deleteSessionDelete,
} from "../projects/[id]/sessions/[sessionId]/route";
import {
  publishStream,
  activeStreamIds,
  resetStreamRegistry,
} from "@/lib/ai/stream-registry";

describe("Projects REST API", () => {
  let testDir: string;
  const originalSecret = process.env.APP_SECRET;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-api-test-"));
    resetStreamRegistry();
  });

  afterEach(async () => {
    if (originalSecret !== undefined) {
      process.env.APP_SECRET = originalSecret;
    } else {
      delete process.env.APP_SECRET;
    }
    resetStreamRegistry();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
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

    // Bad Referer
    const badRefererReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Referer: "http://attacker.com/some/path",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "test-proj", mode: "new" }),
    });
    const resReferer = await createProjectPost(badRefererReq);
    expect(resReferer.status).toBe(403);

    // Bad Content-Type
    const badContentTypeReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "text/plain",
      },
      body: JSON.stringify({ name: "test-proj", mode: "new" }),
    });
    const resCt = await createProjectPost(badContentTypeReq);
    expect(resCt.status).toBe(415);
  });

  it("enforces caller authentication when APP_SECRET is configured", async () => {
    process.env.APP_SECRET = "super-secret-token-32-chars-long!!";

    // Request with missing auth header when APP_SECRET is set
    const unauthReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify({ name: "auth-test", mode: "new", customBaseDir: testDir }),
    });
    const unauthRes = await createProjectPost(unauthReq);
    expect(unauthRes.status).toBe(401);

    // Request with valid auth header
    const authReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
        Authorization: "Bearer super-secret-token-32-chars-long!!",
      },
      body: JSON.stringify({ name: "auth-test-ok", mode: "new", customBaseDir: testDir }),
    });
    const authRes = await createProjectPost(authReq);
    expect(authRes.status).toBe(201);
  });

  it("creates a new project and lists it", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Api Test App",
        mode: "new",
        customBaseDir: testDir,
      }),
    });

    const res = await createProjectPost(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toMatch(/^proj_/);
    expect(body.trusted).toBe(true);

    const listRes = await listProjectsGet(new Request("http://localhost:3000/api/projects"));
    const list = await listRes.json();
    expect(list.some((p: { id: string }) => p.id === body.id)).toBe(true);
  });

  it("rejects invalid project creation payloads", async () => {
    // Missing name
    const noNameReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "new" }),
    });
    const noNameRes = await createProjectPost(noNameReq);
    expect(noNameRes.status).toBe(400);

    // Path traversal in name
    const traversalReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "../../bad-name", mode: "new" }),
    });
    const traversalRes = await createProjectPost(traversalReq);
    expect(traversalRes.status).toBe(400);

    // Reserved name
    const reservedReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "aux", mode: "new" }),
    });
    const reservedRes = await createProjectPost(reservedReq);
    expect(reservedRes.status).toBe(400);

    // Mode existing without directoryPath
    const noDirReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "existing-app", mode: "existing" }),
    });
    const noDirRes = await createProjectPost(noDirReq);
    expect(noDirRes.status).toBe(400);
  });

  it("retrieves, updates, and deletes project details", async () => {
    // Create project
    const createReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Details App",
        description: "Initial description",
        mode: "new",
        customBaseDir: testDir,
      }),
    });
    const createRes = await createProjectPost(createReq);
    const created = await createRes.json();

    // GET details
    const getRes = await getProjectGet(
      new Request(`http://localhost:3000/api/projects/${created.id}`),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(getRes.status).toBe(200);
    const details = await getRes.json();
    expect(details.id).toBe(created.id);
    expect(details.description).toBe("Initial description");

    // GET non-existent
    const notFoundRes = await getProjectGet(
      new Request("http://localhost:3000/api/projects/proj_nonexistent"),
      { params: Promise.resolve({ id: "proj_nonexistent" }) }
    );
    expect(notFoundRes.status).toBe(404);

    // PATCH update
    const patchReq = new Request(`http://localhost:3000/api/projects/${created.id}`, {
      method: "PATCH",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Updated App Name",
        description: "Updated description",
        customInstructions: "Follow strict TypeScript",
      }),
    });
    const patchRes = await updateProjectPatch(patchReq, {
      params: Promise.resolve({ id: created.id }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.name).toBe("Updated App Name");
    expect(updated.description).toBe("Updated description");
    expect(updated.customInstructions).toBe("Follow strict TypeScript");

    // DELETE project
    const deleteReq = new Request(`http://localhost:3000/api/projects/${created.id}`, {
      method: "DELETE",
      headers: {
        Origin: "http://localhost:3000",
      },
    });
    const deleteRes = await deleteProjectDelete(deleteReq, {
      params: Promise.resolve({ id: created.id }),
    });
    expect(deleteRes.status).toBe(200);

    // Subsequent GET should be 404
    const afterDeleteGet = await getProjectGet(
      new Request(`http://localhost:3000/api/projects/${created.id}`),
      { params: Promise.resolve({ id: created.id }) }
    );
    expect(afterDeleteGet.status).toBe(404);
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
    const trustRes = await trustProjectPost(trustReq, {
      params: Promise.resolve({ id: proj.id }),
    });
    expect(trustRes.status).toBe(200);
    const updated = await trustRes.json();
    expect(updated.trusted).toBe(true);

    // Reject non-boolean trust
    const badTrustReq = new Request(`http://localhost:3000/api/projects/${proj.id}/trust`, {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trusted: "yes" }),
    });
    const badTrustRes = await trustProjectPost(badTrustReq, {
      params: Promise.resolve({ id: proj.id }),
    });
    expect(badTrustRes.status).toBe(400);
  });

  it("lists project files ignoring VCS and build directories with TOCTOU check", async () => {
    const projectDir = path.join(testDir, "file-tree-test");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.mkdir(path.join(projectDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(projectDir, ".next"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "build"), { recursive: true });

    await fs.writeFile(path.join(projectDir, "src", "index.ts"), "console.log('hello');");
    await fs.writeFile(path.join(projectDir, "README.md"), "# Project");
    await fs.writeFile(path.join(projectDir, ".git", "config"), "ignored");
    await fs.writeFile(path.join(projectDir, "node_modules", "pkg.json"), "ignored");

    const createReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "File Tree App",
        directoryPath: projectDir,
        mode: "existing",
      }),
    });
    const createRes = await createProjectPost(createReq);
    const proj = await createRes.json();

    const filesRes = await getProjectFilesGet(
      new Request(`http://localhost:3000/api/projects/${proj.id}/files`),
      { params: Promise.resolve({ id: proj.id }) }
    );
    expect(filesRes.status).toBe(200);
    const files: Array<{ path: string; isDirectory: boolean; size: number }> =
      await filesRes.json();

    // Check that ignored directories are excluded
    const paths = files.map((f) => f.path);
    expect(paths).toContain("src");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("README.md");
    expect(paths.some((p) => p.startsWith(".git"))).toBe(false);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".next"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
    expect(paths.some((p) => p.startsWith("build"))).toBe(false);

    // Verify sizes and directory flags
    const indexEntry = files.find((f) => f.path === "src/index.ts");
    expect(indexEntry?.isDirectory).toBe(false);
    expect(indexEntry?.size).toBeGreaterThan(0);

    const srcEntry = files.find((f) => f.path === "src");
    expect(srcEntry?.isDirectory).toBe(true);

    // TOCTOU check: if directory is deleted from disk, files route returns 404
    await fs.rm(projectDir, { recursive: true, force: true });
    const toctouRes = await getProjectFilesGet(
      new Request(`http://localhost:3000/api/projects/${proj.id}/files`),
      { params: Promise.resolve({ id: proj.id }) }
    );
    expect(toctouRes.status).toBe(404);
  });

  it("manages project sessions (list, create, get, delete, stream abort)", async () => {
    const createProjReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Session App",
        mode: "new",
        customBaseDir: testDir,
      }),
    });
    const projRes = await createProjectPost(createProjReq);
    const proj = await projRes.json();

    // List sessions - initially empty
    const initialListRes = await listSessionsGet(
      new Request(`http://localhost:3000/api/projects/${proj.id}/sessions`),
      { params: Promise.resolve({ id: proj.id }) }
    );
    expect(initialListRes.status).toBe(200);
    const initialSessions = await initialListRes.json();
    expect(initialSessions).toEqual([]);

    // Create session
    const createSessReq = new Request(
      `http://localhost:3000/api/projects/${proj.id}/sessions`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "First Session" }),
      }
    );
    const createSessRes = await createSessionPost(createSessReq, {
      params: Promise.resolve({ id: proj.id }),
    });
    expect(createSessRes.status).toBe(201);
    const session = await createSessRes.json();
    expect(session.id).toMatch(/^psess_\d+_/);
    expect(session.title).toBe("First Session");
    expect(session.projectId).toBe(proj.id);

    // Get session by id
    const getSessRes = await getSessionGet(
      new Request(
        `http://localhost:3000/api/projects/${proj.id}/sessions/${session.id}`
      ),
      { params: Promise.resolve({ id: proj.id, sessionId: session.id }) }
    );
    expect(getSessRes.status).toBe(200);
    const fetchedSession = await getSessRes.json();
    expect(fetchedSession.id).toBe(session.id);
    expect(fetchedSession.messages).toEqual([]);

    // Get session with wrong project id -> 404
    const wrongProjGetRes = await getSessionGet(
      new Request(
        `http://localhost:3000/api/projects/wrong_id/sessions/${session.id}`
      ),
      { params: Promise.resolve({ id: "wrong_id", sessionId: session.id }) }
    );
    expect(wrongProjGetRes.status).toBe(404);

    // Simulate active stream on session and test stream abort on session delete
    const streamId = "stream-test-" + Date.now();
    // Publish mock stream
    const mockStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("chunk1");
      },
    });
    publishStream(streamId, session.id, mockStream);
    expect(activeStreamIds().some((s) => s.streamId === streamId)).toBe(true);

    // Update session activeStreamId directly or via session delete
    // To test session delete aborts active stream:
    // We update session row with activeStreamId
    const { saveProjectSession } = await import("@/lib/project-service");
    await saveProjectSession({
      ...session,
      activeStreamId: streamId,
    });

    // Delete session
    const deleteSessReq = new Request(
      `http://localhost:3000/api/projects/${proj.id}/sessions/${session.id}`,
      {
        method: "DELETE",
        headers: {
          Origin: "http://localhost:3000",
        },
      }
    );
    const deleteSessRes = await deleteSessionDelete(deleteSessReq, {
      params: Promise.resolve({ id: proj.id, sessionId: session.id }),
    });
    expect(deleteSessRes.status).toBe(200);

    // Verify stream was aborted
    expect(activeStreamIds().some((s) => s.streamId === streamId)).toBe(false);

    // Verify session no longer exists
    const getDeletedSessRes = await getSessionGet(
      new Request(
        `http://localhost:3000/api/projects/${proj.id}/sessions/${session.id}`
      ),
      { params: Promise.resolve({ id: proj.id, sessionId: session.id }) }
    );
    expect(getDeletedSessRes.status).toBe(404);
  });
});
