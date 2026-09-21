import { sqliteTable, text, integer, blob, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  // Resumable-stream pointer: which published stream is currently
  // generating for this chat (null = idle). Client resume requests
  // re-attach through it. Kept as raw text — it is written from the
  // route layer, not through typed inserts.
  activeStreamId: text("active_stream_id"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
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
  },
  (table) => ({
    sessionIdx: index("idx_chat_messages_session_id").on(table.sessionId),
  })
);

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

export const episodicMemories = sqliteTable(
  "episodic_memories",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => chatSessions.id, {
      onDelete: "set null",
    }),
    content: text("content").notNull(),
    embedding: blob("embedding", { mode: "buffer" }),
    embeddingModel: text("embedding_model"),
    importance: real("importance").notNull().default(0.5),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: integer("last_accessed_at", { mode: "timestamp" }),
    tags: text("tags", { mode: "json" }).$type<string[]>().default(sql`'[]'`),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    consolidatedInto: text("consolidated_into"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    sessionIdx: index("idx_episodic_memories_session_id").on(table.sessionId),
  })
);

export const semanticMemories = sqliteTable("semantic_memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  embedding: blob("embedding", { mode: "buffer" }),
  embeddingModel: text("embedding_model"),
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

/**
 * Key/value settings store (JSON values). Holds user-managed runtime
 * configuration — AI provider registry, embedding settings, etc. — so
 * the server can read it directly and it survives browser changes.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

/**
 * Registered plugin marketplaces (`.claude-plugin/marketplace.json`
 * catalogs, e.g. anthropics/claude-plugins-official). Source payloads
 * describe where the manifest is fetched from (GitHub repo or git URL).
 */
export const pluginMarketplaces = sqliteTable("plugin_marketplaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  ownerName: text("owner_name"),
  source: text("source", { mode: "json" }).$type<Record<string, unknown>>(),
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

/**
 * Installed plugins. The tree lives on disk under
 * data/plugins/<marketplace>/<name>/; this row tracks provenance,
 * enablement and a summary of the mapped components.
 */
export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  marketplaceId: text("marketplace_id")
    .notNull()
    .references(() => pluginMarketplaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  displayName: text("display_name"),
  description: text("description"),
  version: text("version"),
  category: text("category"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  source: text("source", { mode: "json" }).$type<Record<string, unknown>>(),
  components: text("components", { mode: "json" }).$type<
    Record<string, unknown>
  >(),
  installedAt: integer("installed_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

/**
 * Installed agent skills (agentskills.io). File content lives on disk
 * under data/skills/<name>/; this row tracks metadata, provenance and
 * enablement. Plugin-owned skills reference their plugin and cascade
 * with it.
 */
export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  version: text("version"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  source: text("source", { mode: "json" }).$type<Record<string, unknown>>(),
  pluginId: text("plugin_id").references(() => plugins.id, {
    onDelete: "cascade",
  }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

/**
 * Chat slash-commands contributed by installed plugins (commands/*.md).
 * Content is the markdown body; expansion happens client-side.
 */
export const pluginCommands = sqliteTable("plugin_commands", {
  id: text("id").primaryKey(),
  pluginId: text("plugin_id")
    .notNull()
    .references(() => plugins.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  argumentHint: text("argument_hint"),
  content: text("content").notNull(),
});

/**
 * Proactive events surfaced to the user (reminders fired by the
 * `scheduled_reminder` job, and later: briefings, follow-ups). The UI
 * inbox polls `/api/events` and marks entries read.
 */
export const proactiveEvents = sqliteTable("proactive_events", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["reminder", "system"] })
    .notNull()
    .default("reminder"),
  title: text("title").notNull(),
  body: text("body"),
  chatId: text("chat_id"),
  readAt: integer("read_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

export const jobQueue = sqliteTable(
  "job_queue",
  {
    id: text("id").primaryKey(),
    type: text("type", {
      enum: [
        "ingest_turn",
        "reflect_turn",
        "sleep_consolidation",
        "dream_graph_discovery",
        "decay_sweep",
        "scheduled_reminder",
        "proactive_event_check",
      ],
    }).notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    lockedAt: integer("locked_at", { mode: "timestamp" }),
    runAt: integer("run_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    statusRunAtIdx: index("idx_job_queue_status_run_at").on(
      table.status,
      table.runAt
    ),
  })
);

/**
 * Projects workspace metadata. Tracks authorized/trusted directories
 * where full-stack harness coding agents run in isolated project scope.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  directoryPath: text("directory_path").notNull().unique(),
  isCustomDirectory: integer("is_custom_directory", { mode: "boolean" })
    .notNull()
    .default(false),
  trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
  trustedAt: integer("trusted_at", { mode: "timestamp" }),
  customInstructions: text("custom_instructions"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(strftime('%s', 'now'))`),
});

/**
 * Project-specific chat and orchestration sessions.
 */
export const projectSessions = sqliteTable(
  "project_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    activeStreamId: text("active_stream_id"),
    // Durable-run pointer for the Projects harness (spec §4.5). Separate from
    // activeStreamId, which remains the in-process registry pointer for the chat
    // path. At most one of the two is ever set for a session.
    activeRunId: text("active_run_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    projectIdx: index("idx_project_sessions_project_id").on(table.projectId),
  })
);

/**
 * Messages belonging to a project orchestration session.
 */
export const projectMessages = sqliteTable(
  "project_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => projectSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => ({
    sessionIdx: index("idx_project_messages_session_id").on(table.sessionId),
  })
);

