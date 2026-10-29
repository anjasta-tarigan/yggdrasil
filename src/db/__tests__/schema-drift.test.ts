/**
 * Schema drift test: verifies that every column defined in `schema.ts`
 * (the Drizzle ORM schema) exists in the database created by `init.ts`
 * (the inline SQL DDL in `setupFtsAndTriggers`).
 *
 * This prevents the "dual-maintenance drift" failure mode where a column
 * is added to `schema.ts` but forgotten in `init.ts`, causing runtime
 * `SQLITE_ERROR: no such column: …` on fresh databases.
 *
 * The test works by performing a round-trip insert+select for every
 * column in every table through the Drizzle API. If any column is missing
 * from the database, the insert or select will throw.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type CompatDatabaseSync } from "@/db/compat";
import { drizzle } from "@/db/node-sqlite-adapter";
import * as schema from "../schema";
import { setupFtsAndTriggers } from "../init";

describe("Schema drift — init.ts DDL vs schema.ts Drizzle schema", () => {
  let sqlite: CompatDatabaseSync;

  beforeEach(() => {
    sqlite = createTestDb(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    setupFtsAndTriggers(sqlite);
  });

  it("every Drizzle table can be inserted into and read back via Drizzle", () => {
    const db = drizzle(sqlite, { schema });
    const now = new Date();

    // --- chat_sessions ---
    db.insert(schema.chatSessions)
      .values({
        id: "cs-1",
        title: "Test Session",
        titleSource: "auto",
        pinned: true,
        activeStreamId: "stream-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const [cs] = db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, "cs-1"))
      .all();
    expect(cs.title).toBe("Test Session");
    expect(cs.titleSource).toBe("auto");
    expect(cs.pinned).toBe(true);
    expect(cs.activeStreamId).toBe("stream-1");

    // --- chat_messages ---
    db.insert(schema.chatMessages)
      .values({
        id: "cm-1",
        sessionId: "cs-1",
        role: "user",
        content: "Hello world",
        metadata: { _rawParts: [{ type: "text", text: "Hello world" }] },
        createdAt: now,
      })
      .run();
    const [cm] = db.select().from(schema.chatMessages).all();
    expect(cm.role).toBe("user");
    expect(cm.content).toBe("Hello world");
    expect(cm.metadata).toEqual({ _rawParts: [{ type: "text", text: "Hello world" }] });

    // --- working_memories ---
    db.insert(schema.workingMemories)
      .values({
        id: "wm-1",
        content: "Short-term context",
        embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
        tags: ["active"],
        expiresAt: new Date(Date.now() + 3600 * 1000),
        createdAt: now,
      })
      .run();
    const [wm] = db.select().from(schema.workingMemories).all();
    expect(wm.content).toBe("Short-term context");
    expect(wm.tags).toEqual(["active"]);

    // --- episodic_memories ---
    db.insert(schema.episodicMemories)
      .values({
        id: "em-1",
        sessionId: "cs-1",
        content: "Episodic memory content",
        embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
        embeddingModel: "text-embedding-3-small",
        importance: 0.75,
        accessCount: 5,
        lastAccessedAt: now,
        tags: ["fact"],
        metadata: { key: "value" },
        consolidatedInto: "sem-1",
        createdAt: now,
      })
      .run();
    const [em] = db.select().from(schema.episodicMemories).all();
    expect(em.content).toBe("Episodic memory content");
    expect(em.importance).toBeCloseTo(0.75);
    expect(em.embeddingModel).toBe("text-embedding-3-small");

    // --- semantic_memories ---
    db.insert(schema.semanticMemories)
      .values({
        id: "sm-1",
        content: "Semantic memory content",
        embedding: Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer),
        embeddingModel: "text-embedding-3-small",
        importance: 0.6,
        accessCount: 3,
        lastAccessedAt: now,
        tags: ["general"],
        sources: ["session-1"],
        metadata: { category: "fact" },
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const [sm] = db.select().from(schema.semanticMemories).all();
    expect(sm.sources).toEqual(["session-1"]);
    expect(sm.updatedAt).toBeInstanceOf(Date);

    // --- memory_relations ---
    db.insert(schema.memoryRelations)
      .values({
        id: "mr-1",
        fromMemoryId: "wm-1",
        fromMemoryType: "working",
        toMemoryId: "sm-1",
        toMemoryType: "semantic",
        relationType: "derived_from",
        strength: 0.9,
        createdAt: now,
      })
      .run();
    const [mr] = db.select().from(schema.memoryRelations).all();
    expect(mr.strength).toBeCloseTo(0.9);
    expect(mr.relationType).toBe("derived_from");

    // --- settings ---
    db.insert(schema.settings)
      .values({ key: "ai_provider", value: { model: "gpt-4" }, updatedAt: now })
      .run();
    const [setting] = db.select().from(schema.settings).all();
    expect(setting.value).toEqual({ model: "gpt-4" });

    // --- plugin_marketplaces ---
    db.insert(schema.pluginMarketplaces)
      .values({
        id: "mp-1",
        name: "official",
        description: "Official plugins",
        ownerName: "anthropic",
        source: { type: "github", repo: "anthropic/claude-plugins-official" },
        lastSyncedAt: now,
        createdAt: now,
      })
      .run();
    const [mp] = db.select().from(schema.pluginMarketplaces).all();
    expect(mp.name).toBe("official");

    // --- plugins ---
    db.insert(schema.plugins)
      .values({
        id: "pl-1",
        marketplaceId: "mp-1",
        name: "dark-mode",
        displayName: "Dark Mode",
        description: "Toggle dark mode",
        version: "1.0.0",
        category: "ui",
        enabled: true,
        source: { type: "github" },
        components: { panels: [] },
        installedAt: now,
        updatedAt: now,
      })
      .run();
    const [pl] = db.select().from(schema.plugins).all();
    expect(pl.displayName).toBe("Dark Mode");
    expect(pl.enabled).toBe(true);

    // --- skills ---
    db.insert(schema.skills)
      .values({
        id: "sk-1",
        name: "code-review",
        description: "Code review skill",
        version: "1.0.0",
        enabled: true,
        source: { type: "registry" },
        pluginId: "pl-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const [sk] = db.select().from(schema.skills).all();
    expect(sk.name).toBe("code-review");

    // --- plugin_commands ---
    db.insert(schema.pluginCommands)
      .values({
        id: "pc-1",
        pluginId: "pl-1",
        name: "help",
        description: "Show help",
        argumentHint: "[topic]",
        content: "# Help\n\nUseful commands...",
      })
      .run();
    const [pc] = db.select().from(schema.pluginCommands).all();
    expect(pc.name).toBe("help");

    // --- proactive_events ---
    db.insert(schema.proactiveEvents)
      .values({
        id: "pe-1",
        kind: "reminder",
        title: "Reminder",
        body: "Don't forget",
        chatId: "cs-1",
        readAt: now,
        createdAt: now,
      })
      .run();
    const [pe] = db.select().from(schema.proactiveEvents).all();
    expect(pe.kind).toBe("reminder");
    expect(pe.chatId).toBe("cs-1");

    // --- job_queue ---
    db.insert(schema.jobQueue)
      .values({
        id: "jq-1",
        type: "reflect_turn",
        payload: { sessionId: "cs-1" },
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
        lastError: null,
        lockedAt: null,
        runAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const [jq] = db.select().from(schema.jobQueue).all();
    expect(jq.type).toBe("reflect_turn");
    expect(jq.attempts).toBe(0);

    // --- projects ---
    db.insert(schema.projects)
      .values({
        id: "pj-1",
        name: "my-project",
        description: "A test project",
        directoryPath: "/tmp/test",
        isCustomDirectory: true,
        trusted: true,
        trustedAt: now,
        customInstructions: "Be careful",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const [pj] = db.select().from(schema.projects).all();
    expect(pj.directoryPath).toBe("/tmp/test");

    // --- project_sessions ---
    db.insert(schema.projectSessions)
      .values({
        id: "ps-1",
        projectId: "pj-1",
        title: "Project Session 1",
        pinned: true,
        activeStreamId: "stream-1",
        activeRunId: "run-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const [ps] = db.select().from(schema.projectSessions).all();
    expect(ps.activeRunId).toBe("run-1");

    // --- project_messages ---
    db.insert(schema.projectMessages)
      .values({
        id: "pm-1",
        sessionId: "ps-1",
        role: "assistant",
        content: "Hello from project",
        metadata: { usage: 10 },
        createdAt: now,
      })
      .run();
    const [pm] = db.select().from(schema.projectMessages).all();
    expect(pm.role).toBe("assistant");

    // --- web_provider_sessions ---
    db.insert(schema.webProviderSessions)
      .values({
        id: "wps-1",
        providerId: "deepseek-web",
        encryptedPayload: "enc:v1:test",
        status: "verified",
        lastCheckedAt: now,
        lastFailureCode: null,
        userAgentMode: "browser",
        capturedAt: now,
        sessionVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const [wps] = db.select().from(schema.webProviderSessions).all();
    expect(wps.providerId).toBe("deepseek-web");
    expect(wps.userAgentMode).toBe("browser");
  });

  it("CHECK constraints reject invalid importance values", () => {
    expect(() => {
      sqlite
        .prepare(`INSERT INTO episodic_memories (id, content, importance) VALUES ('bad', 'test', -0.5)`)
        .run();
    }).toThrow(/CHECK constraint failed/);
  });

  it("CHECK constraints reject invalid strength values", () => {
    expect(() => {
      sqlite
        .prepare(`INSERT INTO memory_relations (id, from_memory_id, from_memory_type, to_memory_id, to_memory_type, relation_type, strength) VALUES ('bad', 'm1', 'episodic', 'm2', 'semantic', 'rel', 1.5)`)
        .run();
    }).toThrow(/CHECK constraint failed/);
  });

  it("CHECK constraints reject negative attempts", () => {
    expect(() => {
      sqlite
        .prepare(`INSERT INTO job_queue (id, type, payload, run_at, attempts) VALUES ('bad', 'sleep_consolidation', '{}', 0, -1)`)
        .run();
    }).toThrow(/CHECK constraint failed/);
  });

  it("CHECK constraints reject zero max_attempts", () => {
    expect(() => {
      sqlite
        .prepare(`INSERT INTO job_queue (id, type, payload, run_at, max_attempts) VALUES ('bad', 'sleep_consolidation', '{}', 0, 0)`)
        .run();
    }).toThrow(/CHECK constraint failed/);
  });

  it("UNIQUE constraint on memory_relations rejects duplicate relation edges", () => {
    sqlite
      .prepare(`INSERT INTO memory_relations (id, from_memory_id, from_memory_type, to_memory_id, to_memory_type, relation_type, strength) VALUES ('mr-1', 'm1', 'episodic', 'm2', 'semantic', 'related', 0.5)`)
      .run();

    expect(() => {
      sqlite
        .prepare(`INSERT INTO memory_relations (id, from_memory_id, from_memory_type, to_memory_id, to_memory_type, relation_type, strength) VALUES ('mr-2', 'm1', 'episodic', 'm2', 'semantic', 'related', 0.8)`)
        .run();
    }).toThrow(/UNIQUE constraint failed/);
  });
});
