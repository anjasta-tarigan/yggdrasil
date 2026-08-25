import { sqliteTable, text, integer, blob, real } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  embeddedInMemory: text("embedded_in_memory"),
});

export const workingMemories = sqliteTable("working_memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  tags: text("tags", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const episodicMemories = sqliteTable("episodic_memories", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(() => chatSessions.id, {
    onDelete: "set null",
  }),
  content: text("content").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  importance: real("importance").notNull().default(0.5),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
  tags: text("tags", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  consolidatedInto: text("consolidated_into"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const semanticMemories = sqliteTable("semantic_memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  importance: real("importance").notNull().default(0.5),
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
  tags: text("tags", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  sources: text("sources", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const memoryRelations = sqliteTable("memory_relations", {
  id: text("id").primaryKey(),
  fromMemoryId: text("from_memory_id").notNull(),
  fromMemoryType: text("from_memory_type", {
    enum: ["working", "episodic", "semantic"],
  }).notNull(),
  toMemoryId: text("to_memory_id").notNull(),
  toMemoryType: text("to_memory_type", {
    enum: ["working", "episodic", "semantic"],
  }).notNull(),
  relationType: text("relation_type").notNull(),
  strength: real("strength").notNull().default(0.5),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});
