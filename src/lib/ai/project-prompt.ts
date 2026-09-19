// src/lib/ai/project-prompt.ts
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StoredProject } from "@/lib/project-service";
import { assertSafePath, isSensitivePath } from "@/lib/ai/tools/file-security";

const execFileAsync = promisify(execFile);

const MAX_INSTRUCTION_FILE_SIZE = 64 * 1024; // 64KB cap

interface GitInfo {
  isRepo: boolean;
  branch: string | null;
}

/**
 * Safely inspects if directory is a git repo and retrieves current branch.
 * Falls back gracefully on non-git directories, missing git binary, or errors.
 * Uses GIT_CEILING_DIRECTORIES and verifies toplevel matches canonicalPath
 * so subdirectories inside a host repo do not falsely report parent git info.
 */
async function detectGitInfo(canonicalPath: string): Promise<GitInfo> {
  try {
    let resolvedPath = canonicalPath;
    try {
      resolvedPath = await fs.realpath(canonicalPath);
    } catch (err) {
      console.warn("[project-prompt] realpath failed for git detection, using path as-is:", err);
    }

    const ceilingDir = path.dirname(resolvedPath);
    const gitEnv = {
      ...process.env,
      GIT_CEILING_DIRECTORIES: ceilingDir,
    };

    const { stdout: toplevel } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: resolvedPath, timeout: 2000, encoding: "utf-8", env: gitEnv }
    );

    let realTop: string;
    try {
      realTop = await fs.realpath(toplevel.trim());
    } catch (err) {
      console.warn("[project-prompt] realpath failed for git toplevel, falling back to path.resolve:", err);
      realTop = path.resolve(toplevel.trim());
    }

    if (realTop !== resolvedPath) {
      return { isRepo: false, branch: null };
    }

    try {
      const { stdout: branch } = await execFileAsync(
        "git",
        ["branch", "--show-current"],
        { cwd: resolvedPath, timeout: 2000, encoding: "utf-8", env: gitEnv }
      );
      const trimmedBranch = branch.trim();
      if (trimmedBranch) {
        return { isRepo: true, branch: trimmedBranch };
      }

      // Detached HEAD fallback
      const { stdout: commit } = await execFileAsync(
        "git",
        ["rev-parse", "--short", "HEAD"],
        { cwd: resolvedPath, timeout: 2000, encoding: "utf-8", env: gitEnv }
      );
      const trimmedCommit = commit.trim();
      return {
        isRepo: true,
        branch: trimmedCommit ? `HEAD (${trimmedCommit})` : "detached HEAD",
      };
    } catch (err) {
      console.warn("[project-prompt] git branch detection failed (repo but no branch):", err);
      return { isRepo: true, branch: null };
    }
  } catch (err) {
    console.warn("[project-prompt] git detection failed, treating as non-repo:", err);
    return { isRepo: false, branch: null };
  }
}

interface InstructionDoc {
  filename: string;
  content: string;
}

/**
 * Auto-reads AGENTS.md and/or CLAUDE.md from the project root if present.
 * Uses assertSafePath to prevent symlink jail escape & secret leakage.
 * Caps file size to 64KB.
 */
async function readProjectInstructionFiles(
  canonicalPath: string
): Promise<InstructionDoc[]> {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  const docs: InstructionDoc[] = [];

  for (const filename of candidates) {
    try {
      const safePath = await assertSafePath(filename, canonicalPath);
      if (isSensitivePath(safePath)) {
        continue;
      }

      const stat = await fs.stat(safePath);
      if (!stat.isFile()) {
        continue;
      }

      let content: string;
      if (stat.size > MAX_INSTRUCTION_FILE_SIZE) {
        const handle = await fs.open(safePath, "r");
        try {
          const buffer = Buffer.alloc(MAX_INSTRUCTION_FILE_SIZE);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            MAX_INSTRUCTION_FILE_SIZE,
            0
          );
          content = buffer.subarray(0, bytesRead).toString("utf-8");
        } finally {
          await handle.close();
        }
      } else {
        content = await fs.readFile(safePath, "utf-8");
      }

      const trimmed = content.trim();
      if (trimmed && !docs.some((d) => d.content === trimmed)) {
        docs.push({ filename, content: trimmed });
      }
    } catch (err) {
      // File not found, unreadable, symlink jail escape, or sensitive file —
      // these are expected conditions for optional instruction files; log at
      // debug level without interrupting the prompt synthesis.
      console.warn(`[project-prompt] Failed to read instruction file ${filename}:`, err);
    }
  }

  return docs;
}

/**
 * Synthesizes the specialized system prompt for coding agents in a project workspace.
 *
 * Adheres strictly to Claude Code and Everything Claude Code (ECC) best practices:
 * - Environment & Git detection (isolated with git ceiling & toplevel check)
 * - Instruction file injection (AGENTS.md, CLAUDE.md secured against symlink escapes and 64KB capped)
 * - Custom database instructions
 * - Tool hierarchy (Dedicated Tools > Bash)
 * - Safety & blast radius
 * - Verification gate (tests before claiming done)
 * - Anti-slop communication style
 * - Zero memory leakage (NO cognitive memory injection)
 */
export async function synthesizeProjectSystemPrompt(
  project: StoredProject
): Promise<string> {
  // Resolve canonical realpath if available
  let canonicalPath = project.directoryPath;
  try {
    canonicalPath = await fs.realpath(project.directoryPath);
  } catch (err) {
    console.warn("[project-prompt] realpath failed for project directory, using path as-is:", err);
  }

  const [gitInfo, instructionDocs] = await Promise.all([
    detectGitInfo(canonicalPath),
    readProjectInstructionFiles(canonicalPath),
  ]);

  const shell = process.env.SHELL || "/bin/bash";
  const platform = process.platform;
  const gitStatus = gitInfo.isRepo
    ? `Git repository (branch: ${gitInfo.branch ?? "unknown"})`
    : "Not a git repository";

  const sections: string[] = [];

  // 1. Role & Operational Environment
  const envLines: string[] = [
    "# Role & Operational Environment",
    "You are Yggdrasil's specialized coding agent operating inside a dedicated project workspace.",
    "",
    "## Environment Details",
    `- Project Name: ${project.name}`,
  ];
  if (project.description && project.description.trim()) {
    envLines.push(`- Project Description: ${project.description.trim()}`);
  }
  envLines.push(`- Working Directory: ${project.directoryPath}`);
  if (canonicalPath && canonicalPath !== project.directoryPath) {
    envLines.push(`- Canonical Path: ${canonicalPath}`);
  }
  envLines.push(
    `- Platform: ${platform}`,
    `- Shell: ${shell}`,
    `- Git Status: ${gitStatus}`
  );
  sections.push(envLines.join("\n"));

  // 2. Project Instructions (AGENTS.md / CLAUDE.md)
  if (instructionDocs.length > 0) {
    const docSections: string[] = ["# Project Instructions"];
    for (const doc of instructionDocs) {
      docSections.push(`## ${doc.filename}\n${doc.content}`);
    }
    sections.push(docSections.join("\n\n"));
  }

  // 3. Custom Project Instructions (from database)
  if (project.customInstructions && project.customInstructions.trim()) {
    sections.push(
      `# Custom Project Instructions\n${project.customInstructions.trim()}`
    );
  }

  // 4. Tool Hierarchy & Discipline
  sections.push(
    [
      "# Tool Hierarchy & Discipline",
      "",
      "## Dedicated Tools > Bash",
      "Always prioritize dedicated tools over bash shell commands:",
      "- Use `file_operations` with action `read` instead of shell commands (`cat`, `head`, `tail`).",
      "- Use `file_operations` with action `edit` (surgical substring replacement) instead of `sed` or full-file overwrites on existing files.",
      "- Use `file_operations` with action `find` or `grep` instead of shell commands (`find`, `grep`, `rg`).",
      "- Reserve `bash` strictly for builds, tests, linters, package managers, git commands, and process management. Never use bash for file inspection, reading, or simple file edits.",
      "",
      "## Read Before Modifying",
      "Never propose or execute edits on a file without inspecting its existing contents first. Always understand surrounding context.",
      "",
      "## Surgical Edits",
      "Make minimal, surgical modifications using `edit`. Prefer surgical edits over full-file writes (`write`) on existing files to avoid unintended regressions or token waste.",
      "",
      "## Task Planning & Tracking",
      "Plan and track multi-step execution using `manage_tasks` (task_list_manager). Maintain task progress transparently across complex workflows.",
    ].join("\n")
  );

  // 5. Safety & Blast Radius
  sections.push(
    [
      "# Safety & Blast Radius",
      "- Project Jailing: All operations are strictly confined within the project root directory. Never attempt to read, write, or execute commands outside the project boundary.",
      "- Destructive Operations: Operations with high blast radius (deleting files/directories, resetting git history, killing processes) require caution and explicit confirmation when necessary.",
    ].join("\n")
  );

  // 6. Verification Gate
  sections.push(
    [
      "# Verification Gate",
      "Never claim a task is complete until verified:",
      "- Execute relevant test suites or build checks via `bash` before declaring work finished.",
      "- Confirm all checks pass with clean exits.",
      "- Report failures faithfully without suppressing error traces or manufacturing false success claims.",
    ].join("\n")
  );

  // 7. Communication Style (Anti-Slop)
  sections.push(
    [
      "# Communication Style (Anti-Slop)",
      "- Direct, concise, high-signal output.",
      "- Skip conversational preambles, apologies, filler, or repeating user instructions.",
      "- Lead with concrete actions and findings.",
      "- Use precise `file:line` references when referring to code locations.",
    ].join("\n")
  );

  return sections.join("\n\n");
}
