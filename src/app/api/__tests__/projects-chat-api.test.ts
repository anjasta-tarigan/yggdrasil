import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../projects/chat/route";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import path from "node:path";
import os from "node:os";

let sqlite: Database.Database;
let testDb: any;
const tempTestDir = path.join(os.tmpdir(), "yggdrasil-chat-test-" + Date.now());

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

vi.mock("@/lib/ai/provider", () => ({
  defaultModel: "mock-model",
  defaultModelId: "mock-model-id",
  llm: {
    chatModel: vi.fn().mockReturnValue("mocked-chat-model"),
  },
}));

describe("Projects Chat API Route", () => {
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    testDb = drizzle(sqlite, { schema });
  });

  it("rejects chat request when project is untrusted with 403", async () => {
    testDb
      .insert(schema.projects)
      .values({
        id: "proj_untrusted_1",
        name: "Untrusted Project",
        directoryPath: tempTestDir,
        trusted: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const req = new Request("http://localhost/api/projects/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "proj_untrusted_1",
        messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("Project directory is not trusted/approved");
  });

  it("rejects non-existent project with 404", async () => {
    const req = new Request("http://localhost/api/projects/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "nonexistent",
        messages: [],
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});
