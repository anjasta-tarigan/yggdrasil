import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { eq, desc, inArray, notInArray, and } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import {
  projects,
  projectSessions,
  projectMessages,
} from "@/db/schema";
import { tool } from "ai";
import { z } from "zod";
import type { UIMessage } from "ai";

export interface StoredProject {
  id: string;
  name: string;
  description: string | null;
  directoryPath: string;
  trusted: boolean;
  trustedAt: number | null;
  customInstructions: string | null;
  createdAt: number;
  updatedAt: number;
  existsOnDisk?: boolean;
}

export interface StoredProjectSession {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
}

export interface ProjectCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_WRITE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_PER_CALL = 50;

/** Dangerous speed bump patterns for project-scoped commands */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: "privilege escalation is not allowed" },
  { pattern: /\brm\b(?:(?!\n).)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:(?!\n).)*\s\/(?!\w)/, reason: "recursive delete of root / is blocked" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "filesystem formatting is blocked" },
  { pattern: /\bdd\b[^|;&\n]*\bof=\/dev\//, reason: "raw device writes are blocked" },
  { pattern: />\s*\/dev\/(sd|nvme|hd)/, reason: "raw device writes are blocked" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "power commands are blocked" },
  { pattern: /\bchmod\s+-R\s+777\s+\/(?!\w)/, reason: "recursive world-writable / is blocked" },
  { pattern: /(curl|wget)\b[^|;&\n]*\|\s*(ba|z)?sh\b/, reason: "piping remote scripts into a shell is blocked" },
];

export function assertSafeProjectCommand(command: string): void {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      throw new Error(`Blocked command: ${reason}.`);
    }
  }
}

export function validateAndResolveProjectPath(
  projectDirectory: string,
  relativePath: string
): string {
  const normalizedRoot = path.resolve(projectDirectory);
  const cleaned = (relativePath ?? "").replace(/^[/\\]+/, "");
  const resolved = path.resolve(normalizedRoot, cleaned);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Path escapes the project directory: ${relativePath}`);
  }

  // Canonical symlink safety check: if target exists, ensure its realpath does not escape root
  if (fsSync.existsSync(resolved)) {
    const realTarget = fsSync.realpathSync(resolved);
    const realRoot = fsSync.existsSync(normalizedRoot)
      ? fsSync.realpathSync(normalizedRoot)
      : normalizedRoot;
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error(`Path symlink escapes the project directory boundary: ${relativePath}`);
    }
  }

  return resolved;
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

/**
 * List all registered projects.
 */
export async function listProjects(
  db: AppDatabase = defaultDb
): Promise<StoredProject[]> {
  const rows = db.select().from(projects).orderBy(desc(projects.updatedAt)).all();

  return rows.map((r) => {
    const exists = fsSync.existsSync(r.directoryPath);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      directoryPath: r.directoryPath,
      trusted: Boolean(r.trusted),
      trustedAt: r.trustedAt ? r.trustedAt.getTime() : null,
      customInstructions: r.customInstructions,
      createdAt: r.createdAt ? r.createdAt.getTime() : 0,
      updatedAt: r.updatedAt ? r.updatedAt.getTime() : 0,
      existsOnDisk: exists,
    };
  });
}

/**
 * Get project by ID.
 */
export async function getProject(
  id: string,
  db: AppDatabase = defaultDb
): Promise<StoredProject | null> {
  const [r] = db.select().from(projects).where(eq(projects.id, id)).all();
  if (!r) return null;

  return {
    id: r.id,
    name: r.name,
    description: r.description,
    directoryPath: r.directoryPath,
    trusted: Boolean(r.trusted),
    trustedAt: r.trustedAt ? r.trustedAt.getTime() : null,
    customInstructions: r.customInstructions,
    createdAt: r.createdAt ? r.createdAt.getTime() : 0,
    updatedAt: r.updatedAt ? r.updatedAt.getTime() : 0,
    existsOnDisk: fsSync.existsSync(r.directoryPath),
  };
}

export const DEFAULT_WORKSPACE_PROJECTS_DIR = path.resolve(
  process.cwd(),
  "data",
  "projects"
);

/**
 * Create or register a project directory.
 */
export async function createProject(
  input: {
    name: string;
    directoryPath?: string;
    description?: string;
    customInstructions?: string;
    trusted?: boolean;
    mode?: "new" | "existing";
  },
  db: AppDatabase = defaultDb
): Promise<StoredProject> {
  const sanitizedName = input.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";

  const rawPath =
    input.directoryPath && input.directoryPath.trim()
      ? input.directoryPath.trim()
      : path.join(DEFAULT_WORKSPACE_PROJECTS_DIR, sanitizedName);

  const resolvedDir = path.resolve(rawPath);
  const exists = fsSync.existsSync(resolvedDir);

  if (input.mode === "existing" && !exists) {
    throw new Error(
      `Directory does not exist on disk: ${resolvedDir}. Please choose an existing path or select "Create New Project".`
    );
  }

  // Ensure directory exists or create it
  await fs.mkdir(resolvedDir, { recursive: true });

  // When creating a new project, automatically initialize standard project instruction contract
  // per Rule 21 and Rule 06 (AGENTS.md and CLAUDE.md wired to global rule system)
  if (input.mode === "new" || !exists) {
    const agentsFile = path.join(resolvedDir, "AGENTS.md");
    const claudeFile = path.join(resolvedDir, "CLAUDE.md");
    const gitignoreFile = path.join(resolvedDir, ".gitignore");

    if (!fsSync.existsSync(agentsFile)) {
      const agentsContent = `# ${input.name.trim()}

${input.description?.trim() ? `${input.description.trim()}\n\n` : ""}## Conventions & Guidelines
- Follow the rules defined in \`/home/anjasta/.claude/CLAUDE.md\`.
- All build, test, and execution tasks are jailed to this directory.
${input.customInstructions?.trim() ? `\n## Project Specific Instructions\n${input.customInstructions.trim()}\n` : ""}`;
      await fs.writeFile(agentsFile, agentsContent, "utf8");
    }

    if (!fsSync.existsSync(claudeFile)) {
      await fs.writeFile(claudeFile, "@AGENTS.md\n", "utf8");
    }

    if (!fsSync.existsSync(gitignoreFile)) {
      await fs.writeFile(
        gitignoreFile,
        `node_modules/
.next/
dist/
build/
.cache/
tmp/
.env.local
.env.*.local
*.log
`,
        "utf8"
      );
    }
  }

  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  const isTrusted = Boolean(input.trusted);

  db.insert(projects)
    .values({
      id,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      directoryPath: resolvedDir,
      trusted: isTrusted,
      trustedAt: isTrusted ? now : null,
      customInstructions: input.customInstructions?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return (await getProject(id, db))!;
}

/**
 * Set project directory trusted approval status.
 */
export async function setProjectTrusted(
  id: string,
  trusted: boolean,
  db: AppDatabase = defaultDb
): Promise<StoredProject | null> {
  const now = new Date();
  db.update(projects)
    .set({
      trusted,
      trustedAt: trusted ? now : null,
      updatedAt: now,
    })
    .where(eq(projects.id, id))
    .run();

  return getProject(id, db);
}

/**
 * Delete a project and cascade its sessions.
 */
export async function deleteProject(
  id: string,
  db: AppDatabase = defaultDb
): Promise<void> {
  db.delete(projects).where(eq(projects.id, id)).run();
}

/**
 * List sessions for a project. Batches message queries to avoid N+1 SQLite queries.
 */
export async function listProjectSessions(
  projectId: string,
  db: AppDatabase = defaultDb
): Promise<StoredProjectSession[]> {
  const sessionRows = db
    .select()
    .from(projectSessions)
    .where(eq(projectSessions.projectId, projectId))
    .orderBy(desc(projectSessions.updatedAt))
    .all();

  if (sessionRows.length === 0) return [];

  const sessionIds = sessionRows.map((s) => s.id);
  const allMsgRows = db
    .select()
    .from(projectMessages)
    .where(inArray(projectMessages.sessionId, sessionIds))
    .orderBy(projectMessages.createdAt)
    .all();

  const messagesBySession = new Map<string, UIMessage[]>();
  for (const r of allMsgRows) {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const parts = Array.isArray(meta._rawParts)
      ? (meta._rawParts as UIMessage["parts"])
      : [
          {
            type: "text" as const,
            text: r.content,
          },
        ];

    const message: UIMessage = {
      id: r.id,
      role: r.role as "user" | "assistant" | "system",
      parts,
      metadata: (meta.usage || meta.data ? meta : undefined) as UIMessage["metadata"],
    };

    const list = messagesBySession.get(r.sessionId) ?? [];
    list.push(message);
    messagesBySession.set(r.sessionId, list);
  }

  return sessionRows.map((session) => ({
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    createdAt: session.createdAt ? session.createdAt.getTime() : 0,
    updatedAt: session.updatedAt ? session.updatedAt.getTime() : 0,
    messages: messagesBySession.get(session.id) ?? [],
  }));
}

/**
 * Save or update project session and messages.
 */
export async function saveProjectSession(
  session: StoredProjectSession,
  db: AppDatabase = defaultDb
): Promise<void> {
  const now = new Date(session.updatedAt || Date.now());

  db.transaction((tx) => {
    const [existing] = tx
      .select()
      .from(projectSessions)
      .where(eq(projectSessions.id, session.id))
      .all();

    if (!existing) {
      tx.insert(projectSessions)
        .values({
          id: session.id,
          projectId: session.projectId,
          title: session.title,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } else {
      tx.update(projectSessions)
        .set({
          title: session.title,
          updatedAt: now,
        })
        .where(eq(projectSessions.id, session.id))
        .run();
    }

    // Synchronize messages: delete removed ones, then upsert
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

    // Upsert messages
    for (const msg of session.messages) {
      const textContent = msg.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");

      const metadataToSave: Record<string, unknown> = {
        ...(msg.metadata as Record<string, unknown> ?? {}),
        _rawParts: msg.parts,
      };

      const [existingMsg] = tx
        .select()
        .from(projectMessages)
        .where(eq(projectMessages.id, msg.id))
        .all();

      if (!existingMsg) {
        tx.insert(projectMessages)
          .values({
            id: msg.id,
            sessionId: session.id,
            role: msg.role as "user" | "assistant" | "system",
            content: textContent,
            metadata: metadataToSave,
          })
          .run();
      } else {
        tx.update(projectMessages)
          .set({
            content: textContent,
            metadata: metadataToSave,
          })
          .where(eq(projectMessages.id, msg.id))
          .run();
      }
    }
  });
}

/**
 * Creates project-scoped orchestration tools (bash, readFile, writeFile, listFiles, grepFiles)
 * that execute directly within the authorized/trusted directory.
 */
export function createProjectHarnessTools(projectDirectory: string) {
  const root = path.resolve(projectDirectory);

  return {
    projectBash: tool({
      description:
        "Execute a shell command inside the authorized project working directory. Use to run build tools, test suites, git commands, package managers (npm, pnpm, cargo, go, pip), or project inspections.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The shell command to execute"),
      }),
      execute: async ({ command }) => {
        assertSafeProjectCommand(command);

        const safeEnv: NodeJS.ProcessEnv = {
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
          HOME: root,
          USER: "project-agent",
          SHELL: "/bin/bash",
          LANG: process.env.LANG || "en_US.UTF-8",
          TERM: "dumb",
          NODE_ENV: "development",
        };

        return new Promise<ProjectCommandResult>((resolve) => {
          const child = spawn("bash", ["-c", command], {
            cwd: root,
            env: safeEnv,
            detached: true,
          });

          let stdout = "";
          let stderr = "";
          let stdoutOverflow = false;
          let stderrOverflow = false;
          let settled = false;
          let timeoutTimer: NodeJS.Timeout | null = null;
          let forceKillTimer: NodeJS.Timeout | null = null;

          const stdoutDecoder = new StringDecoder("utf8");
          const stderrDecoder = new StringDecoder("utf8");

          const cleanupTimers = () => {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
          };

          const settle = (exitCode: number, extra?: string) => {
            if (settled) return;
            settled = true;
            cleanupTimers();
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
            resolve({
              stdout: truncateOutput(stdout),
              stderr: truncateOutput(
                extra ? `${stderr}${stderr ? "\n" : ""}${extra}` : stderr
              ),
              exitCode,
            });
          };

          // Process group timeout handler with SIGTERM -> SIGKILL escalation
          timeoutTimer = setTimeout(() => {
            if (settled || child.killed) return;
            const pid = child.pid;
            if (pid) {
              try {
                // Kill process group with SIGTERM
                process.kill(-pid, "SIGTERM");
              } catch {
                try {
                  child.kill("SIGTERM");
                } catch {
                  // Ignore if already dead
                }
              }

              // Fallback SIGKILL escalation if process group does not terminate within 2 seconds
              forceKillTimer = setTimeout(() => {
                if (settled) return;
                try {
                  process.kill(-pid, "SIGKILL");
                } catch {
                  try {
                    child.kill("SIGKILL");
                  } catch {
                    // Ignore if already dead
                  }
                }
              }, 2000);
            }
            settle(124, `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`);
          }, COMMAND_TIMEOUT_MS);

          child.stdout?.on("data", (chunk: Buffer) => {
            if (stdoutOverflow) return;
            stdout += stdoutDecoder.write(chunk);
            if (stdout.length > MAX_OUTPUT_CHARS * 2) stdoutOverflow = true;
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            if (stderrOverflow) return;
            stderr += stderrDecoder.write(chunk);
            if (stderr.length > MAX_OUTPUT_CHARS * 2) stderrOverflow = true;
          });

          child.on("error", (err) => settle(127, String(err.message)));
          child.on("close", (code, signal) => {
            if (signal === "SIGTERM" || signal === "SIGKILL") {
              settle(124, `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`);
            } else {
              settle(code ?? 1);
            }
          });
        });
      },
    }),

    projectReadFile: tool({
      description:
        "Read the UTF-8 text content of a file inside the authorized project directory. Relative paths are resolved against the project root.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File path relative to the project root"),
        offset: z.number().int().min(1).default(1).describe("1-based first line to return"),
        limit: z.number().int().min(1).max(2000).default(500).describe("Max lines to return"),
      }),
      execute: async ({ path: filePath, offset, limit }) => {
        try {
          const resolved = validateAndResolveProjectPath(root, filePath);
          const raw = await fs.readFile(resolved, "utf8");
          const lines = raw.split(/\r?\n/);
          const sliced = lines.slice(offset - 1, offset - 1 + limit);
          const formatted = sliced.map((l, i) => `${offset + i}: ${l}`).join("\n");
          return {
            path: filePath,
            totalLines: lines.length,
            content: formatted,
          };
        } catch (err) {
          return {
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    projectWriteFile: tool({
      description:
        "Write (create or overwrite) a file inside the project directory. Creates parent directories automatically. Only target authorized paths.",
      inputSchema: z.object({
        path: z.string().min(1).describe("File path relative to project root"),
        content: z.string().describe("Full content to write"),
      }),
      execute: async ({ path: filePath, content }) => {
        try {
          const resolved = validateAndResolveProjectPath(root, filePath);
          const data = Buffer.from(content, "utf8");
          if (data.byteLength > MAX_WRITE_FILE_BYTES) {
            throw new Error(`File too large (max ${MAX_WRITE_FILE_BYTES} bytes).`);
          }
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, data);
          return {
            path: filePath,
            bytesWritten: data.byteLength,
            status: "success",
          };
        } catch (err) {
          return {
            path: filePath,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    projectListFiles: tool({
      description:
        "List files and directories within a subpath inside the project directory.",
      inputSchema: z.object({
        subpath: z.string().default("").describe("Relative directory path to list"),
      }),
      execute: async ({ subpath }) => {
        try {
          const resolved = validateAndResolveProjectPath(root, subpath);
          const entries = await fs.readdir(resolved, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
          }));
          return { subpath, items };
        } catch (err) {
          return {
            subpath,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
  };
}
