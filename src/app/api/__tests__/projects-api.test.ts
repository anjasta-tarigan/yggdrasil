import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, POST } from "../projects/route";
import {
  GET as GET_BY_ID,
  PATCH as PATCH_BY_ID,
  DELETE as DELETE_BY_ID,
} from "../projects/[id]/route";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import path from "node:path";
import os from "node:os";

let sqlite: Database.Database;
let testDb: any;
const tempTestDir = path.join(os.tmpdir(), "yggdrasil-test-project-" + Date.now());

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

describe("Projects API Routes", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("POST /api/projects creates a project and returns 201", async () => {
    const req = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Web App",
        directoryPath: tempTestDir,
        description: "A test project",
        trusted: true,
        mode: "new",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.name).toBe("Test Web App");
    expect(data.project.trusted).toBe(true);
  });

  it("POST /api/projects with mode=existing rejects non-existent directory", async () => {
    const nonExistentPath = path.join(os.tmpdir(), "non-existent-dir-" + Date.now());
    const req = new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Existing Missing",
        directoryPath: nonExistentPath,
        mode: "existing",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain("Directory does not exist on disk");
  });

  it("GET /api/projects lists registered projects", async () => {
    // Create first
    await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Project 1",
          directoryPath: tempTestDir,
          trusted: false,
        }),
      })
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projects.length).toBe(1);
    expect(data.projects[0].name).toBe("Project 1");
    expect(data.projects[0].trusted).toBe(false);
  });

  it("PATCH /api/projects/[id] updates trusted status", async () => {
    const createRes = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Project Trust Test",
          directoryPath: tempTestDir,
          trusted: false,
        }),
      })
    );
    const { project } = await createRes.json();

    const patchReq = new Request(`http://localhost/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trusted: true }),
    });

    const patchRes = await PATCH_BY_ID(patchReq, {
      params: Promise.resolve({ id: project.id }),
    });
    expect(patchRes.status).toBe(200);
    const patchData = await patchRes.json();
    expect(patchData.project.trusted).toBe(true);
    expect(patchData.project.trustedAt).toBeDefined();
  });

  it("DELETE /api/projects/[id] removes the project", async () => {
    const createRes = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Project To Delete",
          directoryPath: tempTestDir,
          trusted: false,
        }),
      })
    );
    const { project } = await createRes.json();

    const delReq = new Request(`http://localhost/api/projects/${project.id}`, {
      method: "DELETE",
    });

    const delRes = await DELETE_BY_ID(delReq, {
      params: Promise.resolve({ id: project.id }),
    });
    expect(delRes.status).toBe(200);

    const getRes = await GET_BY_ID(delReq, {
      params: Promise.resolve({ id: project.id }),
    });
    expect(getRes.status).toBe(404);
  });
});
