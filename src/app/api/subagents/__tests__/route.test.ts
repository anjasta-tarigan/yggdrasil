import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";

let sqlite: Database.Database;
let testDb: any;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

import { GET, POST, PATCH, DELETE } from "../route";
import { listSubagents } from "@/lib/ai/subagents-service";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  setupFtsAndTriggers(db);
  return drizzle(db, { schema });
}

function jsonReq(
  method: string,
  body: unknown,
  url = "http://localhost/api/subagents"
) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("Subagents CRUD Route", () => {
  beforeEach(() => {
    testDb = freshDb();
    vi.clearAllMocks();
  });

  it("GET lists subagents with the tool registry", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      subagents: Array<{ name: string }>;
      toolRegistry: Array<{ key: string }>;
    };
    expect(json.subagents.length).toBe(3);
    expect(json.subagents.map((s) => s.name)).toContain("Researcher");
    expect(json.toolRegistry.length).toBeGreaterThan(3);
  });

  it("POST creates a subagent (201)", async () => {
    const res = await POST(
      jsonReq("POST", {
        name: "Writer",
        instructions: "You write things.",
        tools: ["memory"],
        maxSteps: 5,
      })
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      subagent: { id: string; name: string; maxSteps: number };
    };
    expect(json.subagent.name).toBe("Writer");
    expect(json.subagent.maxSteps).toBe(5);
    expect(listSubagents(testDb).length).toBe(4);
  });

  it("POST validates input (400 with issues)", async () => {
    const res = await POST(
      jsonReq("POST", {
        name: "",
        instructions: "",
        tools: ["bogus"],
      })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: string[] };
    expect(json.issues.length).toBeGreaterThan(1);
    expect(listSubagents(testDb).length).toBe(3); // unchanged
  });

  it("POST rejects invalid JSON (400)", async () => {
    const res = await POST(
      new Request("http://localhost/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("PATCH updates a subagent", async () => {
    const seeded = listSubagents(testDb);
    const coder = seeded.find((s) => s.name === "Coder")!;

    const res = await PATCH(
      jsonReq("PATCH", { id: coder.id, enabled: false, maxSteps: 30 })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { subagent: { enabled: boolean } };
    expect(json.subagent.enabled).toBe(false);

    const updated = listSubagents(testDb).find((s) => s.id === coder.id)!;
    expect(updated.enabled).toBe(false);
    expect(updated.maxSteps).toBe(30);
  });

  it("PATCH requires an id (400)", async () => {
    const res = await PATCH(jsonReq("PATCH", { enabled: true }));
    expect(res.status).toBe(400);
  });

  it("PATCH unknown id returns 404", async () => {
    const res = await PATCH(jsonReq("PATCH", { id: "sub_ghost", enabled: true }));
    expect(res.status).toBe(404);
  });

  it("DELETE removes a subagent", async () => {
    const seeded = listSubagents(testDb);
    const analyst = seeded.find((s) => s.name === "Analyst")!;

    const res = await DELETE(
      new Request(
        `http://localhost/api/subagents?id=${encodeURIComponent(analyst.id)}`,
        { method: "DELETE" }
      )
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deleted: { id: string } };
    expect(json.deleted.id).toBe(analyst.id);
    expect(listSubagents(testDb).length).toBe(2);
  });

  it("DELETE without id returns 400; unknown id 404", async () => {
    const missing = await DELETE(
      new Request("http://localhost/api/subagents", { method: "DELETE" })
    );
    expect(missing.status).toBe(400);

    const ghost = await DELETE(
      new Request("http://localhost/api/subagents?id=sub_ghost", {
        method: "DELETE",
      })
    );
    expect(ghost.status).toBe(404);
  });
});
