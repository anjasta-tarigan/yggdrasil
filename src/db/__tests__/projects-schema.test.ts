import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";

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
        active_run_id TEXT,
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

  it("creates projects, project_sessions, and project_messages tables via setupFtsAndTriggers", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("project_sessions");
    expect(tableNames).toContain("project_messages");

    const indices = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as { name: string }[];
    const indexNames = indices.map((i) => i.name);

    expect(indexNames).toContain("idx_project_sessions_project_id");
    expect(indexNames).toContain("idx_project_messages_session_id");
  });
});
