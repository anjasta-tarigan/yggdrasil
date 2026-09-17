// src/lib/ai/project-prompt.ts
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StoredProject } from "@/lib/project-service";

const execFileAsync = promisify(execFile);

interface GitInfo {
  isRepo: boolean;
  branch: string | null;
}

/**
 * Safely inspects if directory is a git repo and retrieves current branch.
 * Falls back gracefully on non-git directories, missing git binary, or errors.
 */
async function detectGitInfo(directoryPath: string): Promise<GitInfo> {
  try {
    const { stdout: isInside } = await execFileAsync(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: directoryPath, timeout: 2000, encoding: "utf-8" }
    );

    if (isInside.trim() !== "true") {
      return { isRepo: false, branch: null };
    }

    try {
      const { stdout: branch } = await execFileAsync(
        "git",
        ["branch", "--show-current"],
        { cwd: directoryPath, timeout: 2000, encoding: "utf-8" }
      );
      const trimmedBranch = branch.trim();
      if (trimmedBranch) {
        return { isRepo: true, branch: trimmedBranch };
      }

      // Detached HEAD fallback
      const { stdout: commit } = await execFileAsync(
        "git",
        ["rev-parse", "--short", "HEAD"],
        { cwd: directoryPath, timeout: 2000, encoding: "utf-8" }
      );
      const trimmedCommit = commit.trim();
      return {
        isRepo: true,
        branch: trimmedCommit ? `HEAD (${trimmedCommit})` : "detached HEAD",
      };
    } catch {
      return { isRepo: true, branch: null };
    }
  } catch {
    return { isRepo: false, branch: null };
  }
}

interface InstructionDoc {
  filename: string;
  content: string;
}

/**
 * Auto-reads AGENTS.md and/or CLAUDE.md from the project root if present.
 */
async function readProjectInstructionFiles(
  directoryPath: string
): Promise<InstructionDoc[]> {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  const docs: InstructionDoc[] = [];

  for (const filename of candidates) {
    try {
      const filePath = path.join(directoryPath, filename);
      const content = await fs.readFile(filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed && !docs.some((d) => d.content === trimmed)) {
        docs.push({ filename, content: trimmed });
      }
    } catch {
      // File not found or unreadable, continue to next candidate
    }
  }

  return docs;
}

/**
 * Synthesizes the specialized system prompt for coding agents in a project workspace.
 *
 * Adheres strictly to Claude Code and Everything Claude Code (ECC) best practices:
 * - Environment & Git detection
 * - Instruction file injection (AGENTS.md, CLAUDE.md)
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
  } catch {
    // If directory does not exist yet or realpath fails, keep directoryPath
  }

  const [gitInfo, instructionDocs] = await Promise.all([
    detectGitInfo(project.directoryPath),
    readProjectInstructionFiles(project.directoryPath),
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
    `- Working Directory: ${project.directoryPath}`,
  ];
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
