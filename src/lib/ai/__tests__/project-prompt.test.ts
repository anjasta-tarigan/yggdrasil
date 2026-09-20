import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { synthesizeProjectSystemPrompt } from "../project-prompt";
import type { StoredProject } from "@/lib/project-service";

const execFileAsync = promisify(execFile);

describe("Project System Prompt Engine", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-prompt-test-"));
  });

  it("synthesizes prompt with environment info, tool discipline, and anti-slop rules", async () => {
    const project: StoredProject = {
      id: "proj_1",
      name: "Prompt Test Project",
      description: "A test project",
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: "Use strict TypeScript with no any.",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);

    // Checks essential ECC/Claude Code sections
    expect(prompt).toContain("Prompt Test Project");
    expect(prompt).toContain(testDir);
    expect(prompt).toContain("Dedicated Tools > Bash");
    expect(prompt).toContain("Verification Gate");
    expect(prompt).toContain("Use strict TypeScript with no any.");
    expect(prompt).not.toContain("<cognitive_memory_context>"); // Zero memory leakage

    // Environment info
    expect(prompt).toContain(process.platform);
    expect(prompt).toContain(process.env.SHELL || "/bin/bash");

    // Tool hierarchy & discipline
    expect(prompt).toContain("manage_tasks");
    expect(prompt).toContain("surgical");
    expect(prompt).toContain("file:line");

    // Agentic operating mode + workspace trust
    expect(prompt).toContain("# Agentic Operating Mode");
    expect(prompt).toContain("Workspace Trust: trusted");
    expect(prompt).not.toContain("Multi-Step Agent Loop");
    expect(prompt).not.toContain("Tool Withholding");
    expect(prompt.indexOf("# Agentic Operating Mode")).toBeLessThan(
      prompt.indexOf("# Tool Hierarchy & Discipline")
    );
  });

  it("states read-only fallback and trust approval for untrusted workspaces", async () => {
    const project: StoredProject = {
      id: "proj_untrusted",
      name: "Untrusted Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: false,
      trustedAt: null,
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);

    expect(prompt).toContain("Workspace Trust: NOT trusted");
    expect(prompt).toContain("Do not retry disabled tools");
    expect(prompt).not.toContain("Workspace Trust: trusted");
  });

  it("injects AGENTS.md content when present in directory root", async () => {
    await fs.writeFile(
      path.join(testDir, "AGENTS.md"),
      "## Test Instructions\nAlways run vitest before finishing."
    );

    const project: StoredProject = {
      id: "proj_2",
      name: "Agent Doc Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("Always run vitest before finishing.");
    expect(prompt).toContain("AGENTS.md");
  });

  it("injects CLAUDE.md content when present in directory root", async () => {
    await fs.writeFile(
      path.join(testDir, "CLAUDE.md"),
      "## Claude Instructions\nFollow strict functional programming."
    );

    const project: StoredProject = {
      id: "proj_3",
      name: "Claude Doc Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("Follow strict functional programming.");
    expect(prompt).toContain("CLAUDE.md");
  });

  it("injects both AGENTS.md and CLAUDE.md if distinct files exist", async () => {
    await fs.writeFile(
      path.join(testDir, "AGENTS.md"),
      "Rule A: Write unit tests first."
    );
    await fs.writeFile(
      path.join(testDir, "CLAUDE.md"),
      "Rule B: Never use console.log."
    );

    const project: StoredProject = {
      id: "proj_both",
      name: "Multi Doc Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("Rule A: Write unit tests first.");
    expect(prompt).toContain("Rule B: Never use console.log.");
  });

  it("detects git repository and current branch when directory is a git repo", async () => {
    await execFileAsync("git", ["init"], { cwd: testDir });
    await execFileAsync("git", ["checkout", "-b", "feature/awesome-prompt"], {
      cwd: testDir,
    });

    const project: StoredProject = {
      id: "proj_git",
      name: "Git Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("feature/awesome-prompt");
  });

  it("handles non-git directories gracefully with fallback", async () => {
    const project: StoredProject = {
      id: "proj_nongit",
      name: "Non-Git Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("Non-Git Project");
    expect(prompt).toMatch(/Not a git repository|none|N\/A/i);
  });

  it("omits custom instructions block when customInstructions is null or empty", async () => {
    const project: StoredProject = {
      id: "proj_no_ci",
      name: "No CI Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: "   ",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).not.toContain("## Custom Project Instructions");
  });

  it("enforces zero memory leakage (never mentions cognitive memory)", async () => {
    const project: StoredProject = {
      id: "proj_leak_check",
      name: "Memory Leak Check",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).not.toContain("<cognitive_memory_context>");
    expect(prompt).not.toContain("semantic_memories");
    expect(prompt).not.toContain("workingMemory");
    expect(prompt).not.toContain("episodic_memories");
  });

  it("handles non-existent directory path gracefully without throwing", async () => {
    const nonExistentDir = path.join(testDir, "does-not-exist");
    const project: StoredProject = {
      id: "proj_missing_dir",
      name: "Missing Dir Project",
      description: null,
      directoryPath: nonExistentDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("Missing Dir Project");
    expect(prompt).toContain(nonExistentDir);
    expect(prompt).toMatch(/Not a git repository|none|N\/A/i);
  });

  it("handles detached HEAD in git repository", async () => {
    await execFileAsync("git", ["init"], { cwd: testDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: testDir });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: testDir });
    await fs.writeFile(path.join(testDir, "dummy.txt"), "hello");
    await execFileAsync("git", ["add", "."], { cwd: testDir });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: testDir });
    const { stdout: hash } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: testDir });
    await execFileAsync("git", ["checkout", hash.trim()], { cwd: testDir });

    const project: StoredProject = {
      id: "proj_detached",
      name: "Detached Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("HEAD");
  });

  it("deduplicates identical AGENTS.md and CLAUDE.md content", async () => {
    const identicalText = "Identical team rules for both agent configs.";
    await fs.writeFile(path.join(testDir, "AGENTS.md"), identicalText);
    await fs.writeFile(path.join(testDir, "CLAUDE.md"), identicalText);

    const project: StoredProject = {
      id: "proj_dedup",
      name: "Dedup Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    // Should appear exactly once in prompt
    const occurrences = prompt.split(identicalText).length - 1;
    expect(occurrences).toBe(1);
  });

  it("includes canonical path when directory is symlinked", async () => {
    const realTargetDir = path.join(testDir, "real-target");
    const symlinkDir = path.join(testDir, "symlink-dir");
    await fs.mkdir(realTargetDir);
    await fs.symlink(realTargetDir, symlinkDir);

    const project: StoredProject = {
      id: "proj_symlink",
      name: "Symlink Project",
      description: null,
      directoryPath: symlinkDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain(symlinkDir);
    expect(prompt).toContain(realTargetDir);
  });

  it("rejects and drops symlink escaping outside project root or pointing to sensitive files in instruction files", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "outside-test-"));
    const secretFile = path.join(outsideDir, "secret.txt");
    await fs.writeFile(secretFile, "SUPER_SECRET_EXTERNAL_KEY_12345");

    try {
      // Symlink AGENTS.md to an outside file
      await fs.symlink(secretFile, path.join(testDir, "AGENTS.md"));

      // Also create an in-workspace sensitive file (.env) and symlink CLAUDE.md to it
      const envFile = path.join(testDir, ".env");
      await fs.writeFile(envFile, "INTERNAL_ENV_SECRET=abcdef");
      await fs.symlink(envFile, path.join(testDir, "CLAUDE.md"));

      const project: StoredProject = {
        id: "proj_escape",
        name: "Escape Attempt Project",
        description: null,
        directoryPath: testDir,
        isCustomDirectory: false,
        trusted: true,
        trustedAt: Date.now(),
        customInstructions: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const prompt = await synthesizeProjectSystemPrompt(project);
      expect(prompt).not.toContain("SUPER_SECRET_EXTERNAL_KEY_12345");
      expect(prompt).not.toContain("INTERNAL_ENV_SECRET=abcdef");
      expect(prompt).not.toContain("# Project Instructions");
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not report parent repo git status for subdirectories without their own git repository", async () => {
    // Initialize parent repo
    await execFileAsync("git", ["init"], { cwd: testDir });
    await execFileAsync("git", ["checkout", "-b", "parent-host-branch"], {
      cwd: testDir,
    });

    // Create a nested subproject directory without its own .git
    const subDir = path.join(testDir, "subproject-without-git");
    await fs.mkdir(subDir, { recursive: true });

    const project: StoredProject = {
      id: "proj_nested",
      name: "Nested Subproject",
      description: null,
      directoryPath: subDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).not.toContain("parent-host-branch");
    expect(prompt).toContain("Not a git repository");
  });

  it("caps instruction file content to 64KB and truncates oversized content", async () => {
    const prefix = "ALLOWED_START_OF_INSTRUCTIONS\n";
    const padding = "A".repeat(64 * 1024);
    const suffix = "\nEXCESS_END_OF_INSTRUCTIONS_SHOULD_BE_TRUNCATED";
    await fs.writeFile(path.join(testDir, "AGENTS.md"), prefix + padding + suffix);

    const project: StoredProject = {
      id: "proj_large_file",
      name: "Large Instruction Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const prompt = await synthesizeProjectSystemPrompt(project);
    expect(prompt).toContain("ALLOWED_START_OF_INSTRUCTIONS");
    expect(prompt).not.toContain("EXCESS_END_OF_INSTRUCTIONS_SHOULD_BE_TRUNCATED");
  });

  it("injects project description into environment block when present, and omits when null", async () => {
    const withDesc: StoredProject = {
      id: "proj_desc_yes",
      name: "Desc Project",
      description: "A specialized project description for agent context.",
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const promptWithDesc = await synthesizeProjectSystemPrompt(withDesc);
    expect(promptWithDesc).toContain(
      "- Project Description: A specialized project description for agent context."
    );

    const withoutDesc: StoredProject = {
      id: "proj_desc_no",
      name: "No Desc Project",
      description: null,
      directoryPath: testDir,
      isCustomDirectory: false,
      trusted: true,
      trustedAt: Date.now(),
      customInstructions: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const promptWithoutDesc = await synthesizeProjectSystemPrompt(withoutDesc);
    expect(promptWithoutDesc).not.toContain("- Project Description:");
  });
});
