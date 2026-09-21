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

    // A `.git` entry is a necessary precondition for this directory to be a
    // repo root. Checking it first turns the common case — a plain project
    // directory — into a cheap stat instead of a failed `git` spawn whose
    // "not a git repository" stderr is expected noise, not a warning.
    const hasGitEntry = await fs
      .stat(path.join(resolvedPath, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!hasGitEntry) {
      return { isRepo: false, branch: null };
    }

    const ceilingDir = path.dirname(resolvedPath);
    // Spec §3.3: strip secrets (APP_SECRET, API keys, DB paths) from subprocess
    // env and never leak the host home directory into the child.
    const gitEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: resolvedPath,
      USER: "project-agent",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      TERM: "dumb",
      NODE_ENV: process.env.NODE_ENV || "development",
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
    // Expected for a non-repo directory or a host without `git` on PATH;
    // neither is actionable, so this is debug-level, not a warning.
    console.debug(
      "[project-prompt] git detection skipped, treating as non-repo:",
      err instanceof Error ? err.message : String(err)
    );
    return { isRepo: false, branch: null };
  }
}

interface InstructionDoc {
  filename: string;
  content: string;
}

/** Whether `err` is a Node.js "file or directory not found" error. */
function isFileNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
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
      // A missing AGENTS.md / CLAUDE.md is the normal case for most projects,
      // so it is skipped without logging (otherwise every chat request would
      // print two stack traces). Anything else (unreadable file, symlink jail
      // escape, ...) is unexpected and stays visible, as a one-line warning
      // with the reason only. Prompt synthesis is never interrupted.
      if (isFileNotFound(err)) continue;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[project-prompt] Skipped instruction file ${filename}: ${reason}`);
    }
  }

  return docs;
}

/**
 * Synthesizes the specialized system prompt for coding agents in a project workspace.
 *
 * Adheres strictly to Claude Code and Everything Claude Code (ECC) best practices:
 * - Environment & Git detection (isolated with git ceiling & toplevel check)
 * - Agentic operating mode (act-don't-describe, inspect before editing)
 * - Workspace trust status (explicit read-only fallback when untrusted)
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
  if (project.trusted) {
    envLines.push(
      "- Workspace Trust: trusted (file writes and shell commands are enabled)"
    );
  } else {
    envLines.push(
      "- Workspace Trust: NOT trusted. `file_operations` write/edit and `bash` are disabled; read-only exploration (list, find, grep, read) still works. If the task requires modifying files or running commands, do the read-only analysis you can, then tell the user to approve directory trust in the project view and stop. Do not retry disabled tools. State explicitly that nothing was verified by running commands."
    );
  }
  sections.push(envLines.join("\n"));

  // 2. Agentic Operating Mode
  sections.push(
    [
      "# Agentic Operating Mode",
      "- You are an autonomous coding agent, not a conversational assistant. Keep working until the user's request is completely resolved before ending your turn. Stop early only when genuinely blocked by something tools cannot resolve (missing credentials, an ambiguous requirement with materially different outcomes, a denied approval, or an untrusted workspace).",
      "- Act, don't describe. When asked to implement, fix, refactor or change something, make the change in the workspace with tools. Do not paste code into chat as a substitute for editing files.",
      "- Never guess about the codebase. Before answering questions about it or editing it, inspect the relevant files with `file_operations` (`list`, `find`, `grep`, `read`).",
      "- For any task needing more than two tool calls, create a plan with `manage_tasks` first and update it as items complete.",
      "- Between tool calls you may add one short line stating what you are doing and why. Do not narrate at length.",
      "- Finish with a brief report: files changed, commands run with their results, and anything you could not verify.",
    ].join("\n")
  );

  // 3. Project Instructions (AGENTS.md / CLAUDE.md)
  if (instructionDocs.length > 0) {
    const docSections: string[] = ["# Project Instructions"];
    for (const doc of instructionDocs) {
      docSections.push(`## ${doc.filename}\n${doc.content}`);
    }
    sections.push(docSections.join("\n\n"));
  }

  // 4. Custom Project Instructions (from database)
  if (project.customInstructions && project.customInstructions.trim()) {
    sections.push(
      `# Custom Project Instructions\n${project.customInstructions.trim()}`
    );
  }

  // 5. Tool Hierarchy & Discipline
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
      "- `write` is for creating a new file, or for a deliberate full replacement (pass `overwrite: true`). It is REFUSED on an existing file otherwise, and the refused call costs a full round trip — so do not reach for `write` on a file that already exists.",
      "- You already know a file exists once you have `read` it, or seen its path in a `list`, `find`, or `grep` result. Change it with `edit`. Never `write` a path you have just observed — that call can only fail, and it costs a round trip to find out.",
      "- If you do not know whether a file exists, find out with `read` (a miss is cheap and tells you the file is new) before deciding between `write` and `edit`.",
      "- To change an existing file: `read` the region first, then `edit` with an `oldString` copied exactly from what you read. `oldString` must match exactly once, so include enough surrounding context to be unique.",
      "- Batch related changes to one file into one `edit` rather than several small ones: each tool call is a full model round trip, and the round trip dominates the cost of the change itself.",
      "- Copy `oldString` from the `read` output you just received — never reconstruct it from memory. A guessed `oldString` either fails to match or lands the replacement in the wrong place, which is how a file ends up internally inconsistent.",
      "- When you change a file, change all the places that depend on it in the same pass: an updated function signature, export, type, or prop that callers still use the old way is a mismatch you created.",
      "",
      "## Task Planning & Tracking",
      "Plan and track multi-step execution using `manage_tasks` (task_list_manager). Maintain task progress transparently across complex workflows.",
    ].join("\n")
  );

  // 6. Safety & Blast Radius
  sections.push(
    [
      "# Safety & Blast Radius",
      "- Project Jailing: All operations are strictly confined within the project root directory. Never attempt to read, write, or execute commands outside the project boundary.",
      "- Destructive Operations: Operations with high blast radius (deleting files/directories, resetting git history, killing processes) require caution and explicit confirmation when necessary.",
    ].join("\n")
  );

  // 7. Verification Gate
  sections.push(
    [
      "# Verification Gate",
      "Never claim a task is complete until verified:",
      "- After editing source files, run the project's own check before declaring done: prefer its type-checker, then its build, then its tests. Detect the right command from the project's manifests (e.g. a `typecheck`/`build`/`test` script in package.json, a Cargo.toml, a go.mod) rather than assuming.",
      "- A verification you cannot run must be named as unverified. Do not describe a change as working because the edit succeeded — the edit succeeding only means the text was written.",
      "- If a check fails, fix the cause and re-run it. Do not report success while a check you ran is failing, and do not stop with a known failure unless you are genuinely blocked.",
      "- Execute relevant test suites or build checks via `bash` before declaring work finished.",
      "- Confirm all checks pass with clean exits.",
      "- Report failures faithfully without suppressing error traces or manufacturing false success claims.",
    ].join("\n")
  );

  // 8. Communication Style (Anti-Slop)
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
