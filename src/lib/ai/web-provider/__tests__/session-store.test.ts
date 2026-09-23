import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { createSessionStore } from "../session-store";

describe("WebProviderSessionStore", () => {
  let sqlite: Database.Database;
  let store: ReturnType<typeof createSessionStore>;
  const testSecret = "test-secret-at-least-32-chars-long-12345";

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    const db = drizzle(sqlite, { schema });
    store = createSessionStore({ db, secret: testSecret });
  });

  it("saves, encrypts, and retrieves a web session", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "sk-session-secret-token",
      userAgentMode: "browser",
      selectedUserAgent: "Mozilla/5.0 Test",
    });

    const session = await store.getSession("deepseek-web");
    expect(session).not.toBeNull();
    expect(session?.userToken).toBe("sk-session-secret-token");
    expect(session?.selectedUserAgent).toBe("Mozilla/5.0 Test");
    expect(session?.status).toBe("verified");
    expect(session?.sessionVersion).toBe(1);

    // Verify database row does NOT contain plaintext token
    const row = sqlite
      .prepare("SELECT encrypted_payload FROM web_provider_sessions WHERE provider_id = ?")
      .get("deepseek-web") as { encrypted_payload: string };
    expect(row.encrypted_payload).toContain("enc:v1:");
    expect(row.encrypted_payload).not.toContain("sk-session-secret-token");
  });

  it("atomically replaces an existing session and increments version", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "token-v1",
      userAgentMode: "server-default",
    });

    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "token-v2",
      userAgentMode: "custom",
      selectedUserAgent: "CustomUA/1.0",
    });

    const session = await store.getSession("deepseek-web");
    expect(session?.userToken).toBe("token-v2");
    expect(session?.sessionVersion).toBe(2);

    const count = sqlite
      .prepare("SELECT COUNT(*) as c FROM web_provider_sessions WHERE provider_id = ?")
      .get("deepseek-web") as { c: number };
    expect(count.c).toBe(1);
  });

  it("deletes a session cleanly", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "to-delete",
      userAgentMode: "browser",
    });

    await store.deleteSession("deepseek-web");
    const session = await store.getSession("deepseek-web");
    expect(session).toBeNull();
  });

  it("refuses to operate if secret is missing or too short", () => {
    expect(() => createSessionStore({ db: drizzle(sqlite, { schema }), secret: "" })).toThrow(
      /APP_SECRET is required/
    );
    expect(() => createSessionStore({ db: drizzle(sqlite, { schema }), secret: "short-secret" })).toThrow(
      /APP_SECRET is required/
    );
  });

  it("returns unconfigured view when no session exists", async () => {
    const view = await store.getSessionView("deepseek-web");
    expect(view).toEqual({
      providerId: "deepseek-web",
      status: "not-configured",
      lastCheckedAt: null,
      userAgentMode: null,
      capturedAt: null,
    });
  });

  it("returns redacted view without exposing token or ciphertext", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "super-secret-token",
      userAgentMode: "custom",
      selectedUserAgent: "MyAgent/1.0",
    });

    const view = await store.getSessionView("deepseek-web");
    expect(view.providerId).toBe("deepseek-web");
    expect(view.status).toBe("verified");
    expect(view.userAgentMode).toBe("custom");
    expect(view.capturedAt).toBeInstanceOf(Date);
    expect((view as unknown as Record<string, unknown>).userToken).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).encryptedPayload).toBeUndefined();
  });

  it("updates session status and failure code", async () => {
    await store.saveSession({
      providerId: "deepseek-web",
      userToken: "session-token",
      userAgentMode: "browser",
    });

    await store.updateStatus("deepseek-web", "rejected", "auth_failed");

    const session = await store.getSession("deepseek-web");
    expect(session?.status).toBe("rejected");
    expect(session?.lastFailureCode).toBe("auth_failed");
  });

  it("returns null gracefully if encrypted payload is corrupted", async () => {
    sqlite
      .prepare(
        `INSERT INTO web_provider_sessions (id, provider_id, encrypted_payload, status, session_version)
         VALUES ('s-corrupt', 'corrupted-provider', 'not-valid-envelope', 'verified', 1)`
      )
      .run();

    const session = await store.getSession("corrupted-provider");
    expect(session).toBeNull();
  });
});
