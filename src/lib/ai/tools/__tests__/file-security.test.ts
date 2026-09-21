import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { assertSafePath, isSensitivePath, isDefaultIgnoredPath, filterSafePaths } from "../file-security";

describe("File Security & Boundary Verification", () => {
  let tmpRoot: string;
  let workspaceRoot: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpRoot = path.join(os.tmpdir(), "ygg-security-test-" + crypto.randomUUID());
    workspaceRoot = path.join(tmpRoot, "workspace");
    outsideDir = path.join(tmpRoot, "outside");

    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("allows paths inside the workspace", async () => {
    const filePath = path.join(workspaceRoot, "valid.txt");
    await fs.writeFile(filePath, "hello", "utf8");

    const resolved = await assertSafePath("valid.txt", workspaceRoot);
    expect(resolved).toBe(await fs.realpath(filePath));
  });

  it("rejects direct directory traversal (../../)", async () => {
    await expect(assertSafePath("../../outside.txt", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("rejects single-hop symlink escapes pointing outside workspace", async () => {
    const outsideTarget = path.join(outsideDir, "secret.txt");
    await fs.writeFile(outsideTarget, "secret data", "utf8");

    const symlinkPath = path.join(workspaceRoot, "symlink-out");
    await fs.symlink(outsideTarget, symlinkPath);

    await expect(assertSafePath("symlink-out", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("rejects multi-hop chained symlink escapes", async () => {
    const outsideTarget = path.join(outsideDir, "deep-secret.txt");
    await fs.writeFile(outsideTarget, "deep secret", "utf8");

    const intermediateLink = path.join(workspaceRoot, "link-1");
    const secondLink = path.join(workspaceRoot, "link-2");

    await fs.symlink(outsideTarget, intermediateLink);
    await fs.symlink(intermediateLink, secondLink);

    await expect(assertSafePath("link-2", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("detects and rejects dangling symlinks pointing outside workspace for not-yet-created files", async () => {
    const danglingOutsideTarget = path.join(outsideDir, "future-file.txt");
    const symlinkPath = path.join(workspaceRoot, "dangling-link");
    await fs.symlink(danglingOutsideTarget, symlinkPath);

    await expect(assertSafePath("dangling-link", workspaceRoot)).rejects.toThrow(
      /Security Violation: Path escapes workspace root/
    );
  });

  it("identifies sensitive credential files correctly", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.local")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath("id_rsa")).toBe(true);
    expect(isSensitivePath("id_ed25519")).toBe(true);
    expect(isSensitivePath("cert.pem")).toBe(true);
    expect(isSensitivePath("private.key")).toBe(true);
    expect(isSensitivePath(".aws/credentials")).toBe(true);
    expect(isSensitivePath(".git/config")).toBe(true);
    expect(isSensitivePath(".npmrc")).toBe(true);
    expect(isSensitivePath(".env-backup")).toBe(true);
    expect(isSensitivePath(".env.old")).toBe(true);
    expect(isSensitivePath("id_rsa_backup")).toBe(true);
    expect(isSensitivePath("id_rsa_old")).toBe(true);
    expect(isSensitivePath("id_rsa.pub")).toBe(true);
    expect(isSensitivePath("notes-about-env-vars.md")).toBe(false);
    expect(isSensitivePath("keystore-notes.md")).toBe(false);
    expect(isSensitivePath("normal-code.ts")).toBe(false);
  });

  it("identifies default ignored build folders", () => {
    expect(isDefaultIgnoredPath("node_modules")).toBe(true);
    expect(isDefaultIgnoredPath(".git")).toBe(true);
    expect(isDefaultIgnoredPath(".next")).toBe(true);
    expect(isDefaultIgnoredPath(".npm")).toBe(true);
    expect(isDefaultIgnoredPath("src/index.ts")).toBe(false);
  });

  it("rejects access to sensitive files via assertSafePath", async () => {
    const envFile = path.join(workspaceRoot, ".env");
    await fs.writeFile(envFile, "SECRET=123", "utf8");

    await expect(assertSafePath(".env", workspaceRoot)).rejects.toThrow(
      /Security Violation: Access to sensitive file is blocked/
    );

    const sshKeyFile = path.join(workspaceRoot, "id_rsa");
    await fs.writeFile(sshKeyFile, "dummy-key", "utf8");

    await expect(assertSafePath("id_rsa", workspaceRoot)).rejects.toThrow(
      /Security Violation: Access to sensitive file is blocked/
    );
  });

  it("filters out escaping paths, sensitive paths, and default ignored paths with filterSafePaths", async () => {
    await fs.writeFile(path.join(workspaceRoot, "app.ts"), "export const x = 1;", "utf8");
    await fs.writeFile(path.join(workspaceRoot, ".env"), "SECRET=123", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "node_modules", "dep.js"), "module.exports={}", "utf8");

    const inputPaths = [
      "app.ts",
      ".env",
      "../../outside.txt",
      "node_modules/dep.js",
      "non-existent-safe.ts",
    ];

    const safePaths = await filterSafePaths(inputPaths, workspaceRoot);
    expect(safePaths).toEqual(["app.ts", "non-existent-safe.ts"]);
  });

  it("handles non-existent files correctly when workspace path involves symlinks", async () => {
    const realDir = path.join(tmpRoot, "real-workspace");
    await fs.mkdir(realDir, { recursive: true });
    const symlinkedWorkspace = path.join(tmpRoot, "symlink-workspace");
    await fs.symlink(realDir, symlinkedWorkspace);

    const resolved = await assertSafePath("new-file.txt", symlinkedWorkspace);
    const expectedCanonical = path.join(await fs.realpath(realDir), "new-file.txt");
    expect(resolved).toBe(expectedCanonical);
  });
});
