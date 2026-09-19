import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { eq, desc, inArray, notInArray, and, isNull, count, max } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { projects, projectSessions, projectMessages } from "@/db/schema";
import type { UIMessage } from "ai";

export interface StoredProject {
  id: string;
  name: string;
  description: string | null;
  directoryPath: string;
  isCustomDirectory: boolean;
  trusted: boolean;
  trustedAt: number | null;
  customInstructions: string | null;
  createdAt: number;
  updatedAt: number;
  existsOnDisk?: boolean;
  sessionCount?: number;
  lastActiveAt?: number | null;
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  mode: "new" | "existing";
  directoryPath?: string;
  customBaseDir?: string;
  customInstructions?: string | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  customInstructions?: string | null;
}

export interface StoredProjectSession {
  id: string;
  projectId: string;
  title: string;
  pinned?: boolean;
  activeStreamId?: string | null;
  createdAt?: number;
  updatedAt?: number;
  messages: UIMessage[];
}

import { sanitizeProjectName } from "./project-utils";
export { sanitizeProjectName };

/**
 * Revalidates canonical realpath on disk to guard against TOCTOU vulnerabilities,
 * directory deletion, unmounting, or symlink evasion.
 */
export async function resolveCanonicalProjectPath(projectPath: string): Promise<string> {
  try {
    const stat = await fs.stat(projectPath);
    if (!stat.isDirectory()) {
      throw new Error(`Project directory does not exist or is not a directory: "${projectPath}"`);
    }
    return await fs.realpath(projectPath);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT" || error.message?.includes("is not a directory")) {
      throw new Error(`Project directory does not exist: "${projectPath}"`);
    }
    throw err;
  }
}

async function safeWriteIfNotExists(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { flag: "wx" });
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== "EEXIST") {
      throw err;
    }
  }
}

export async function checkProjectExistsOnDisk(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function toStoredProject(
  row: typeof projects.$inferSelect,
  existsOnDisk?: boolean,
  sessionCount?: number,
  lastActiveAt?: number | null
): StoredProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    directoryPath: row.directoryPath,
    isCustomDirectory: Boolean(row.isCustomDirectory),
    trusted: Boolean(row.trusted),
    trustedAt: row.trustedAt
      ? row.trustedAt instanceof Date
        ? row.trustedAt.getTime()
        : Number(row.trustedAt)
      : null,
    customInstructions: row.customInstructions ?? null,
    createdAt: row.createdAt
      ? row.createdAt instanceof Date
        ? row.createdAt.getTime()
        : Number(row.createdAt)
      : 0,
    updatedAt: row.updatedAt
      ? row.updatedAt instanceof Date
        ? row.updatedAt.getTime()
        : Number(row.updatedAt)
      : 0,
    ...(typeof existsOnDisk === "boolean" ? { existsOnDisk } : {}),
    ...(typeof sessionCount === "number" ? { sessionCount } : {}),
    ...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
  };
}

/**
 * Creates a new project in data/projects/<sanitizedName> or registers an existing directory.
 * Auto-trusts new projects; existing directories default to untrusted.
 */
export async function createProject(
  input: CreateProjectInput,
  db: AppDatabase = defaultDb
): Promise<StoredProject> {
  const id = `proj_${Date.now()}_${nanoid(8)}`;
  const now = new Date();

  if (input.mode === "new") {
    const sanitizedName = sanitizeProjectName(input.name);
    const baseDir = input.customBaseDir || path.resolve(process.cwd(), "data/projects");
    const targetDir = path.resolve(baseDir, sanitizedName);

    // Lexical containment validation
    const resolvedBase = path.resolve(baseDir);
    if (!targetDir.startsWith(resolvedBase + path.sep) && targetDir !== resolvedBase) {
      throw new Error("Path traversal detected outside base directory");
    }

    await fs.mkdir(targetDir, { recursive: true });
    const canonicalPath = await resolveCanonicalProjectPath(targetDir);

    // Bootstrap AGENTS.md, CLAUDE.md, and .gitignore if not present
    const agentsPath = path.join(canonicalPath, "AGENTS.md");
    const claudePath = path.join(canonicalPath, "CLAUDE.md");
    const gitignorePath = path.join(canonicalPath, ".gitignore");

    await safeWriteIfNotExists(
      agentsPath,
      `# ${sanitizedName}\n\nProject workspace managed by Yggdrasil.\n`
    );
    await safeWriteIfNotExists(
      claudePath,
      `@~/.claude/CLAUDE.md\n@AGENTS.md\n`
    );
    await safeWriteIfNotExists(
      gitignorePath,
      `node_modules/\n.git/\n.env*\ndist/\nbuild/\n.DS_Store\n`
    );

    const values = {
      id,
      name: input.name.trim(),
      description: input.description ?? null,
      directoryPath: canonicalPath,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: now,
      customInstructions: input.customInstructions ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(projects).values(values);

    return toStoredProject(values, true);
  } else if (input.mode === "existing") {
    if (!input.directoryPath) {
      throw new Error("directoryPath is required for existing project mode");
    }

    const canonicalPath = await resolveCanonicalProjectPath(input.directoryPath);

    const values = {
      id,
      name: input.name.trim(),
      description: input.description ?? null,
      directoryPath: canonicalPath,
      isCustomDirectory: true,
      trusted: false,
      trustedAt: null,
      customInstructions: input.customInstructions ?? null,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(projects).values(values);

    return toStoredProject(values, true);
  } else {
    throw new Error(`Invalid project mode: ${String((input as CreateProjectInput).mode)}`);
  }
}

export async function listProjects(
  db: AppDatabase = defaultDb
): Promise<StoredProject[]> {
  const rows = await db
    .select()
    .from(projects)
    .orderBy(desc(projects.updatedAt));

  const stats = await db
    .select({
      projectId: projectSessions.projectId,
      sessionCount: count(),
      lastActive: max(projectSessions.updatedAt),
    })
    .from(projectSessions)
    .groupBy(projectSessions.projectId);

  const statsMap = new Map<string, { count: number; lastActive: number | null }>();
  for (const s of stats) {
    const lastActiveMs = s.lastActive
      ? s.lastActive instanceof Date
        ? s.lastActive.getTime()
        : Number(s.lastActive)
      : null;
    statsMap.set(s.projectId, { count: s.sessionCount, lastActive: lastActiveMs });
  }

  return Promise.all(
    rows.map(async (row) => {
      const existsOnDisk = await checkProjectExistsOnDisk(row.directoryPath);
      const projectStats = statsMap.get(row.id);
      return toStoredProject(
        row,
        existsOnDisk,
        projectStats?.count ?? 0,
        projectStats?.lastActive ?? null
      );
    })
  );
}

export interface PaginatedProjectsResult {
  projects: StoredProject[];
  total: number;
  totalPages: number;
  hasMore: boolean;
  hasPrev: boolean;
}

export async function listProjectsPaginated(
  page: number = 1,
  limit: number = 20,
  db: AppDatabase = defaultDb
): Promise<PaginatedProjectsResult> {
  const normalizedPage = Math.max(1, page);
  const normalizedLimit = Math.max(1, Math.min(100, limit));
  const offset = (normalizedPage - 1) * normalizedLimit;

  const [{ count: total }] = await db
    .select({ count: count() })
    .from(projects);

  const rows = await db
    .select()
    .from(projects)
    .orderBy(desc(projects.updatedAt))
    .limit(normalizedLimit)
    .offset(offset);

  const stats = await db
    .select({
      projectId: projectSessions.projectId,
      sessionCount: count(),
      lastActive: max(projectSessions.updatedAt),
    })
    .from(projectSessions)
    .groupBy(projectSessions.projectId);

  const statsMap = new Map<string, { count: number; lastActive: number | null }>();
  for (const s of stats) {
    const lastActiveMs = s.lastActive
      ? s.lastActive instanceof Date
        ? s.lastActive.getTime()
        : Number(s.lastActive)
      : null;
    statsMap.set(s.projectId, { count: s.sessionCount, lastActive: lastActiveMs });
  }

  const projectList = await Promise.all(
    rows.map(async (row) => {
      const existsOnDisk = await checkProjectExistsOnDisk(row.directoryPath);
      const projectStats = statsMap.get(row.id);
      return toStoredProject(
        row,
        existsOnDisk,
        projectStats?.count ?? 0,
        projectStats?.lastActive ?? null
      );
    })
  );

  const totalPages = Math.max(1, Math.ceil(total / normalizedLimit));

  return {
    projects: projectList,
    total,
    totalPages,
    hasMore: normalizedPage < totalPages,
    hasPrev: normalizedPage > 1,
  };
}

export async function deleteProjects(
  ids: string[],
  db: AppDatabase = defaultDb
): Promise<void> {
  if (ids.length === 0) return;
  db.transaction((tx) => {
    // Collect session IDs for all projects to delete
    const sessions = tx
      .select({ id: projectSessions.id })
      .from(projectSessions)
      .where(inArray(projectSessions.projectId, ids))
      .all();
    const sessionIds = sessions.map((s) => s.id);

    // Delete messages first (FK constraint), then sessions, then projects
    if (sessionIds.length > 0) {
      tx.delete(projectMessages)
        .where(inArray(projectMessages.sessionId, sessionIds))
        .run();
    }
    if (sessionIds.length > 0) {
      tx.delete(projectSessions)
        .where(inArray(projectSessions.projectId, ids))
        .run();
    }
    tx.delete(projects).where(inArray(projects.id, ids)).run();
  });
}

export async function getProject(
  id: string,
  db: AppDatabase = defaultDb
): Promise<StoredProject | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, id));
  if (!row) return null;
  const existsOnDisk = await checkProjectExistsOnDisk(row.directoryPath);
  return toStoredProject(row, existsOnDisk);
}

export async function updateProject(
  id: string,
  updates: UpdateProjectInput,
  db: AppDatabase = defaultDb
): Promise<StoredProject | null> {
  const existing = await getProject(id, db);
  if (!existing) return null;

  const updateValues: Partial<typeof projects.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (updates.name !== undefined) {
    updateValues.name = updates.name.trim();
  }
  if (updates.description !== undefined) {
    updateValues.description = updates.description;
  }
  if (updates.customInstructions !== undefined) {
    updateValues.customInstructions = updates.customInstructions;
  }

  await db
    .update(projects)
    .set(updateValues)
    .where(eq(projects.id, id));

  return getProject(id, db);
}

export async function setProjectTrusted(
  id: string,
  trusted: boolean,
  db: AppDatabase = defaultDb
): Promise<StoredProject | null> {
  const existing = await getProject(id, db);
  if (!existing) return null;

  const now = new Date();
  await db
    .update(projects)
    .set({
      trusted,
      trustedAt: trusted ? now : null,
      updatedAt: now,
    })
    .where(eq(projects.id, id));

  return getProject(id, db);
}

export async function deleteProject(
  id: string,
  db: AppDatabase = defaultDb
): Promise<void> {
  db.transaction((tx) => {
    const sessions = tx
      .select({ id: projectSessions.id })
      .from(projectSessions)
      .where(eq(projectSessions.projectId, id))
      .all();
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      tx.delete(projectMessages)
        .where(inArray(projectMessages.sessionId, sessionIds))
        .run();
      tx.delete(projectSessions)
        .where(eq(projectSessions.projectId, id))
        .run();
    }
    tx.delete(projects).where(eq(projects.id, id)).run();
  });
}

export async function listProjectSessions(
  projectId: string,
  db: AppDatabase = defaultDb
): Promise<StoredProjectSession[]> {
  const sessions = await db
    .select()
    .from(projectSessions)
    .where(eq(projectSessions.projectId, projectId))
    .orderBy(desc(projectSessions.updatedAt));

  if (sessions.length === 0) return [];

  const sessionIds = sessions.map((s) => s.id);
  const allMessages = await db
    .select()
    .from(projectMessages)
    .where(inArray(projectMessages.sessionId, sessionIds))
    .orderBy(projectMessages.createdAt);

  const messagesBySession = new Map<string, UIMessage[]>();
  for (const r of allMessages) {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const parts = Array.isArray(meta._rawParts)
      ? (meta._rawParts as UIMessage["parts"])
      : [
          {
            type: "text" as const,
            text: r.content,
          },
        ];

    const msg: UIMessage = {
      id: r.id,
      role: r.role as "user" | "assistant" | "system",
      parts,
      metadata: (meta.usage || meta.data ? meta : undefined) as UIMessage["metadata"],
    };

    const list = messagesBySession.get(r.sessionId) ?? [];
    list.push(msg);
    messagesBySession.set(r.sessionId, list);
  }

  return sessions.map((session) => ({
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    pinned: Boolean(session.pinned),
    activeStreamId: session.activeStreamId ?? null,
    createdAt: session.createdAt
      ? session.createdAt instanceof Date
        ? session.createdAt.getTime()
        : Number(session.createdAt)
      : 0,
    updatedAt: session.updatedAt
      ? session.updatedAt instanceof Date
        ? session.updatedAt.getTime()
        : Number(session.updatedAt)
      : 0,
    messages: messagesBySession.get(session.id) ?? [],
  }));
}

export async function getProjectSession(
  sessionId: string,
  db: AppDatabase = defaultDb
): Promise<StoredProjectSession | null> {
  const [session] = await db
    .select()
    .from(projectSessions)
    .where(eq(projectSessions.id, sessionId));

  if (!session) return null;

  const messageRows = await db
    .select()
    .from(projectMessages)
    .where(eq(projectMessages.sessionId, session.id))
    .orderBy(projectMessages.createdAt);

  const messages: UIMessage[] = messageRows.map((r) => {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const parts = Array.isArray(meta._rawParts)
      ? (meta._rawParts as UIMessage["parts"])
      : [
          {
            type: "text" as const,
            text: r.content,
          },
        ];

    return {
      id: r.id,
      role: r.role as "user" | "assistant" | "system",
      parts,
      metadata: (meta.usage || meta.data ? meta : undefined) as UIMessage["metadata"],
    };
  });

  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    pinned: Boolean(session.pinned),
    activeStreamId: session.activeStreamId ?? null,
    createdAt: session.createdAt
      ? session.createdAt instanceof Date
        ? session.createdAt.getTime()
        : Number(session.createdAt)
      : 0,
    updatedAt: session.updatedAt
      ? session.updatedAt instanceof Date
        ? session.updatedAt.getTime()
        : Number(session.updatedAt)
      : 0,
    messages,
  };
}

export async function saveProjectSession(
  session: StoredProjectSession,
  db: AppDatabase = defaultDb
): Promise<void> {
  const now = new Date(session.updatedAt || Date.now());
  const createdAt = session.createdAt ? new Date(session.createdAt) : now;

  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.id, session.id))
      .all();

    if (existing.length === 0) {
      tx.insert(projectSessions)
        .values({
          id: session.id,
          projectId: session.projectId,
          title: session.title,
          pinned: Boolean(session.pinned),
          activeStreamId: session.activeStreamId ?? null,
          createdAt,
          updatedAt: now,
        })
        .run();
    } else {
      tx.update(projectSessions)
        .set({
          projectId: session.projectId,
          title: session.title,
          pinned: Boolean(session.pinned),
          activeStreamId:
            session.activeStreamId !== undefined
              ? session.activeStreamId
              : existing[0].activeStreamId,
          updatedAt: now,
        })
        .where(eq(projectSessions.id, session.id))
        .run();
    }

    // Sync messages: delete removed ones, then upsert
    const currentMessageIds = session.messages.map((m) => m.id);
    if (currentMessageIds.length > 0) {
      tx.delete(projectMessages)
        .where(
          and(
            eq(projectMessages.sessionId, session.id),
            notInArray(projectMessages.id, currentMessageIds)
          )
        )
        .run();
    } else {
      tx.delete(projectMessages)
        .where(eq(projectMessages.sessionId, session.id))
        .run();
    }

    if (session.messages.length === 0) return;

    // Batch query existing message IDs (avoids N+1 selects)
    const existingMessageIds = new Set(
      tx
        .select({ id: projectMessages.id })
        .from(projectMessages)
        .where(
          and(
            eq(projectMessages.sessionId, session.id),
            inArray(projectMessages.id, currentMessageIds)
          )
        )
        .all()
        .map((r) => r.id)
    );

    for (const message of session.messages) {
      const contentField = (message as { content?: unknown }).content;
      const textContent = Array.isArray(message.parts)
        ? message.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        : typeof contentField === "string"
        ? contentField
        : "";

      const metadataToSave: Record<string, unknown> = {
        ...((message.metadata as Record<string, unknown>) ?? {}),
        _rawParts: message.parts,
      };

      if (!existingMessageIds.has(message.id)) {
        tx.insert(projectMessages)
          .values({
            id: message.id,
            sessionId: session.id,
            role: message.role as "user" | "assistant" | "system",
            content: textContent,
            metadata: metadataToSave,
          })
          .run();
      } else {
        tx.update(projectMessages)
          .set({
            role: message.role as "user" | "assistant" | "system",
            content: textContent,
            metadata: metadataToSave,
          })
          .where(eq(projectMessages.id, message.id))
          .run();
      }
    }
  });
}

/**
 * Atomically claims a session's activeStreamId via a single conditional
 * UPDATE — `active_stream_id IS NULL` ensures that if another concurrent
 * request has already claimed a stream, this claim fails (0 rows changed)
 * and the caller receives 409 Conflict. Eliminates the TOCTOU window
 * between the read-check and the subsequent save.
 *
 * Spec §4.3: "At most 1 active LLM generation stream per project_session."
 */
export function claimProjectSessionStream(
  sessionId: string,
  streamId: string,
  db: AppDatabase = defaultDb
): boolean {
  const result = db
    .update(projectSessions)
    .set({
      activeStreamId: streamId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSessions.id, sessionId),
        isNull(projectSessions.activeStreamId)
      )
    )
    .run();

  return result.changes > 0;
}

/**
 * Atomically releases a session's activeStreamId only if it still matches
 * `expectedStreamId`. This prevents the onEnd / stop handler of a
 * completed stream from clobbering a freshly-claimed stream on a
 * subsequent request (TOCTOU in clearActiveSessionStream).
 */
export function releaseProjectSessionStream(
  sessionId: string,
  expectedStreamId: string,
  db: AppDatabase = defaultDb
): boolean {
  const result = db
    .update(projectSessions)
    .set({
      activeStreamId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(projectSessions.id, sessionId),
        eq(projectSessions.activeStreamId, expectedStreamId)
      )
    )
    .run();

  return result.changes > 0;
}

export async function deleteProjectSession(
  sessionId: string,
  db: AppDatabase = defaultDb
): Promise<void> {
  db.transaction((tx) => {
    tx.delete(projectMessages).where(eq(projectMessages.sessionId, sessionId)).run();
    tx.delete(projectSessions).where(eq(projectSessions.id, sessionId)).run();
  });
}
