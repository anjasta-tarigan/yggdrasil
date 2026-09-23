import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";

describe("web_provider_sessions schema", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
  });

  it("creates the web_provider_sessions table with unique provider_id", () => {
    const tableInfo = sqlite.pragma("table_info(web_provider_sessions)") as Array<{ name: string }>;
    const columns = tableInfo.map((c) => c.name);

    expect(columns).toContain("id");
    expect(columns).toContain("provider_id");
    expect(columns).toContain("encrypted_payload");
    expect(columns).toContain("status");
    expect(columns).toContain("last_checked_at");
    expect(columns).toContain("last_failure_code");
    expect(columns).toContain("user_agent_mode");
    expect(columns).toContain("captured_at");
    expect(columns).toContain("session_version");
    expect(columns).toContain("created_at");
    expect(columns).toContain("updated_at");

    // Test uniqueness on provider_id
    sqlite
      .prepare(
        `INSERT INTO web_provider_sessions (id, provider_id, encrypted_payload, status, session_version)
         VALUES ('s1', 'deepseek-web', 'enc:v1:test', 'verified', 1)`
      )
      .run();

    expect(() => {
      sqlite
        .prepare(
          `INSERT INTO web_provider_sessions (id, provider_id, encrypted_payload, status, session_version)
           VALUES ('s2', 'deepseek-web', 'enc:v1:test2', 'verified', 1)`
        )
        .run();
    }).toThrow(/UNIQUE constraint failed: web_provider_sessions.provider_id/);

    // Verify Drizzle ORM integration
    const db = drizzle(sqlite, { schema });
    const rows = db.select().from(schema.webProviderSessions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].providerId).toBe("deepseek-web");
  });
});
