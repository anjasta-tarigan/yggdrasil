import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Rule 06 (Environment Isolation): each test file gets its own SQLite
// database file so parallel workers don't race on shared rows.
const testDbPath = vi.hoisted(() => {
  const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const p = `${tmpDir}/ygg-api-${process.pid}-${Date.now()}.db`;
  process.env.DATABASE_PATH = p;
  return p;
});

import {
  GET as listProjectsGet,
  POST as createProjectPost,
  DELETE as bulkDeleteProjects,
} from "../projects/route";
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
import { sqlite } from "@/db";

describe("Projects REST API", () => {
  let testDir: string;
  const originalSecret = process.env.APP_SECRET;
  const originalNodeEnv = process.env.NODE_ENV;

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
    const envRecord = process.env as Record<string, string | undefined>;
    if (originalNodeEnv !== undefined) {
      envRecord.NODE_ENV = originalNodeEnv;
    } else {
      delete envRecord.NODE_ENV;
    }
    resetStreamRegistry();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (err) {
      // ignore cleanup errors during teardown
      console.debug("[projects-api] testDir cleanup failed:", err);
    }
  });

  afterAll(async () => {
    sqlite.close();
    await fs.rm(testDbPath, { force: true }).catch((err) =>
      console.debug("[projects-api] Failed to delete test database:", err)
    );
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

  it("allows loopback requests without a token in production when APP_SECRET is configured", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.APP_SECRET = "production-secret-token-32-chars-long!!";

    // Spec §3.8.1/§3.8.3: the server is device-local (loopback-bound). The
    // browser UI never sends an Authorization header, so loopback same-origin
    // requests must pass without one — otherwise add/import project 401s.
    //
    // Next.js injects its own `x-forwarded-for: 127.0.0.1` on real requests,
    // so that header is reproduced here; a presence-only check would wrongly
    // classify these as remote and reintroduce the 401.
    const getRes = await listProjectsGet(
      new Request("http://localhost:3000/api/projects", {
        method: "GET",
        headers: {
          Host: "127.0.0.1:2302",
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-host": "127.0.0.1:2302",
          "x-forwarded-proto": "http",
        },
      })
    );
    expect(getRes.status).toBe(200);

    const postRes = await createProjectPost(
      new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:2302",
          Origin: "http://127.0.0.1:2302",
          "Content-Type": "application/json",
          "x-forwarded-for": "127.0.0.1",
        },
        body: JSON.stringify({
          name: "prod-local-ok",
          mode: "new",
          customBaseDir: testDir,
        }),
      })
    );
    expect(postRes.status).toBe(201);
  });

  it("requires Bearer auth in production for non-loopback requests when APP_SECRET is configured", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    process.env.APP_SECRET = "production-secret-token-32-chars-long!!";

    // A remote (non-loopback) caller gets no implicit trust.
    const getRes = await listProjectsGet(
      new Request("http://192.168.1.33:2302/api/projects", {
        method: "GET",
        headers: { Host: "192.168.1.33:2302" },
      })
    );
    expect(getRes.status).toBe(401);
    expect((await getRes.json()).error).toBe("Unauthorized");

    // Proxied/tunnelled requests arrive on loopback but carry a foreign
    // client IP; they must not inherit the loopback trust bypass.
    const proxiedRes = await listProjectsGet(
      new Request("http://127.0.0.1:2302/api/projects", {
        method: "GET",
        headers: {
          Host: "127.0.0.1:2302",
          "x-forwarded-for": "203.0.113.7",
        },
      })
    );
    expect(proxiedRes.status).toBe(401);

    const postRes = await createProjectPost(
      new Request("http://192.168.1.33:2302/api/projects", {
        method: "POST",
        headers: {
          Host: "192.168.1.33:2302",
          Origin: "http://192.168.1.33:2302",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "prod-remote-no-auth",
          mode: "new",
          customBaseDir: testDir,
        }),
      })
    );
    expect(postRes.status).toBe(401);
    expect((await postRes.json()).error).toBe("Unauthorized");

    // A remote caller presenting the correct token is allowed.
    const okRes = await createProjectPost(
      new Request("http://192.168.1.33:2302/api/projects", {
        method: "POST",
        headers: {
          Host: "192.168.1.33:2302",
          Origin: "http://192.168.1.33:2302",
          "Content-Type": "application/json",
          Authorization: "Bearer production-secret-token-32-chars-long!!",
        },
        body: JSON.stringify({
          name: "prod-remote-ok",
          mode: "new",
          customBaseDir: testDir,
        }),
      })
    );
    expect(okRes.status).toBe(201);
  });

  it("accepts IPv6 Host headers and origins cleanly", async () => {
    const ipv6Req = new Request("http://[::1]:3000/api/projects", {
      method: "POST",
      headers: {
        Host: "[::1]:3000",
        Origin: "http://[::1]:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "ipv6-app",
        mode: "new",
        customBaseDir: testDir,
      }),
    });
    const ipv6Res = await createProjectPost(ipv6Req);
    expect(ipv6Res.status).toBe(201);
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
    const createdInList = list.find((p: { id: string }) => p.id === body.id);
    expect(createdInList).toBeDefined();
    expect(createdInList?.existsOnDisk).toBe(true);
  });

  it("reports existsOnDisk as true when directory exists and false when removed", async () => {
    const createReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "disk-check-app",
        mode: "new",
        customBaseDir: testDir,
      }),
    });
    const createRes = await createProjectPost(createReq);
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.existsOnDisk).toBe(true);

    // Initial check: directory exists on disk
    const listRes1 = await listProjectsGet(new Request("http://localhost:3000/api/projects"));
    const list1 = await listRes1.json();
    const item1 = list1.find((p: { id: string }) => p.id === created.id);
    expect(item1?.existsOnDisk).toBe(true);

    const getRes1 = await getProjectGet(
      new Request(`http://localhost:3000/api/projects/${created.id}`),
      { params: Promise.resolve({ id: created.id }) }
    );
    const details1 = await getRes1.json();
    expect(details1.existsOnDisk).toBe(true);

    // Remove the directory from disk
    await fs.rm(created.directoryPath, { recursive: true, force: true });

    // Subsequent check: existsOnDisk should be false
    const listRes2 = await listProjectsGet(new Request("http://localhost:3000/api/projects"));
    const list2 = await listRes2.json();
    const item2 = list2.find((p: { id: string }) => p.id === created.id);
    expect(item2?.existsOnDisk).toBe(false);

    const getRes2 = await getProjectGet(
      new Request(`http://localhost:3000/api/projects/${created.id}`),
      { params: Promise.resolve({ id: created.id }) }
    );
    const details2 = await getRes2.json();
    expect(details2.existsOnDisk).toBe(false);
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

  it("aborts active streams across sessions when project is deleted via DELETE /api/projects/[id]", async () => {
    // Create project
    const createReq = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "cascade-stream-abort",
        mode: "new",
        customBaseDir: testDir,
      }),
    });
    const createRes = await createProjectPost(createReq);
    const proj = await createRes.json();

    // Create session
    const createSessReq = new Request(
      `http://localhost:3000/api/projects/${proj.id}/sessions`,
      {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Session With Stream" }),
      }
    );
    const createSessRes = await createSessionPost(createSessReq, {
      params: Promise.resolve({ id: proj.id }),
    });
    const session = await createSessRes.json();

    // Publish active stream
    const streamId = "cascade-stream-" + Date.now();
    const mockStream = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("chunk-cascade");
      },
    });
    publishStream(streamId, session.id, mockStream);
    expect(activeStreamIds().some((s) => s.streamId === streamId)).toBe(true);

    const { saveProjectSession } = await import("@/lib/project-service");
    await saveProjectSession({
      ...session,
      activeStreamId: streamId,
    });

    // Delete project
    const deleteProjReq = new Request(`http://localhost:3000/api/projects/${proj.id}`, {
      method: "DELETE",
      headers: {
        Origin: "http://localhost:3000",
      },
    });
    const deleteProjRes = await deleteProjectDelete(deleteProjReq, {
      params: Promise.resolve({ id: proj.id }),
    });
    expect(deleteProjRes.status).toBe(200);

    // Verify stream was aborted via streamRegistry.abort
    expect(activeStreamIds().some((s) => s.streamId === streamId)).toBe(false);
  });

  it("returns paginated project list when page and limit params are provided", async () => {
    // Capture initial count (projects from prior tests in this file)
    const initialRes = await listProjectsGet(
      new Request("http://localhost:3000/api/projects?page=1&limit=1000")
    );
    const initial = await initialRes.json();
    const initialCount = initial.total;

    // Create 5 projects to span multiple pages (limit = 2)
    for (let i = 0; i < 5; i++) {
      const req = new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `paginated-proj-${i}`,
          mode: "new",
          customBaseDir: testDir,
        }),
      });
      const res = await createProjectPost(req);
      expect(res.status).toBe(201);
    }

    const expectedTotal = initialCount + 5;
    const expectedTotalPages = Math.ceil(expectedTotal / 2);

    // Page 1 with limit 2 should return 2 projects
    const page1Res = await listProjectsGet(
      new Request("http://localhost:3000/api/projects?page=1&limit=2")
    );
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(Array.isArray(page1.projects)).toBe(true);
    expect(page1.projects.length).toBe(2);
    expect(page1.total).toBe(expectedTotal);
    expect(page1.totalPages).toBe(expectedTotalPages);
    expect(page1.hasMore).toBe(true);
    expect(page1.hasPrev).toBe(false);

    // Page 2 should return 2 different projects
    const page2Res = await listProjectsGet(
      new Request("http://localhost:3000/api/projects?page=2&limit=2")
    );
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json();
    expect(page2.projects.length).toBe(2);
    expect(page2.hasMore).toBe(true);
    expect(page2.hasPrev).toBe(true);

    // Verify pages return different projects
    const page1Ids = new Set(page1.projects.map((p: { id: string }) => p.id));
    const page2Ids = new Set(page2.projects.map((p: { id: string }) => p.id));
    expect(page1Ids.size + page2Ids.size).toBe(4);

    // Last page should have hasMore=false
    const lastPageRes = await listProjectsGet(
      new Request(`http://localhost:3000/api/projects?page=${expectedTotalPages}&limit=2`)
    );
    const lastPage = await lastPageRes.json();
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.hasPrev).toBe(true);
  });

  it("falls back to flat array when no pagination params are provided", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "fallback-array-test",
        mode: "new",
        customBaseDir: testDir,
      }),
    });
    await createProjectPost(req);

    const res = await listProjectsGet(
      new Request("http://localhost:3000/api/projects")
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("supports bulk delete via DELETE on projects collection", async () => {
    // Create 3 projects
    const created: { id: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const req = new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `bulk-delete-test-${i}`,
          mode: "new",
          customBaseDir: testDir,
        }),
      });
      const res = await createProjectPost(req);
      expect(res.status).toBe(201);
      created.push(await res.json());
    }

    // Verify they exist
    const listRes = await listProjectsGet(
      new Request("http://localhost:3000/api/projects")
    );
    const list = await listRes.json() as { id: string }[];
    for (const proj of created) {
      expect(list.find((p) => p.id === proj.id)).toBeDefined();
    }

    // Bulk delete all 3
    const deleteReq = new Request("http://localhost:3000/api/projects", {
      method: "DELETE",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: created.map((p) => p.id) }),
    });
    const deleteRes = await bulkDeleteProjects(deleteReq);
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.success).toBe(true);
    expect(deleteBody.deleted).toBe(3);

    // Verify they're gone
    const postListRes = await listProjectsGet(
      new Request("http://localhost:3000/api/projects")
    );
    const postList = await postListRes.json() as { id: string }[];
    for (const proj of created) {
      expect(postList.find((p) => p.id === proj.id)).toBeUndefined();
    }
  });

  it("rejects bulk delete with empty ids array", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "DELETE",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: [] }),
    });
    const res = await bulkDeleteProjects(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(0);
  });

  it("rejects bulk delete with missing ids field", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "DELETE",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ foo: "bar" }),
    });
    const res = await bulkDeleteProjects(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ids must be an array/);
  });

  it("rejects bulk delete with non-string ids", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "DELETE",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids: ["valid-id", 12345] }),
    });
    const res = await bulkDeleteProjects(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/strings/);
  });
});
