// src/cli/__tests__/paths.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveInstallPaths,
  ensureSecurePermissions,
  ensureSymlink,
  addPathToProfile,
} from "../utils/paths";

describe("CLI Path Utilities", () => {
  const tmpDir = path.join(os.tmpdir(), "ygg-paths-test-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves default directory hierarchy correctly", () => {
    const paths = resolveInstallPaths(tmpDir);
    expect(paths.baseDir).toBe(tmpDir);
    expect(paths.appDir).toBe(path.join(tmpDir, "app"));
    expect(paths.dataDir).toBe(path.join(tmpDir, "data"));
    expect(paths.modelsDir).toBe(path.join(tmpDir, "data", "models"));
    expect(paths.rerankerDir).toBe(path.join(tmpDir, "data", "models", "reranker"));
    expect(paths.logsDir).toBe(path.join(tmpDir, "data", "logs"));
    expect(paths.skillsDir).toBe(path.join(tmpDir, "data", "skills"));
    expect(paths.pluginsDir).toBe(path.join(tmpDir, "data", "plugins"));
    expect(paths.envFile).toBe(path.join(tmpDir, ".env"));
    expect(paths.pidFile).toBe(path.join(tmpDir, "yggdrasil.pid"));
    expect(paths.binDir).toBe(path.join(tmpDir, "bin"));
  });

  it("resolves default directory using homedir when customBaseDir is omitted", () => {
    const paths = resolveInstallPaths();
    expect(paths.baseDir).toBe(path.join(os.homedir(), ".yggdrasil"));
    expect(paths.appDir).toBe(path.join(os.homedir(), ".yggdrasil", "app"));
  });

  it("ensures secure permissions (0o600) on files", async () => {
    const secretFile = path.join(tmpDir, "secret.env");
    await fs.writeFile(secretFile, "SECRET=123", "utf8");
    await ensureSecurePermissions(secretFile);
    if (process.platform !== "win32") {
      const stat = await fs.stat(secretFile);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("creates and overwrites symlinks safely without throwing EEXIST", async () => {
    const targetDir = path.join(tmpDir, "target");
    const linkPath = path.join(tmpDir, "link");
    await fs.mkdir(targetDir, { recursive: true });

    await ensureSymlink(targetDir, linkPath);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

    // Call again to verify idempotency
    await ensureSymlink(targetDir, linkPath);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("links a file when kind is 'file' so Next.js can read it from the project root", async () => {
    // Regression: the installer wrote ~/.yggdrasil/.env while the service runs
    // from ~/.yggdrasil/app, where Next.js loads env files from. Without this
    // link, APP_SECRET is unset on macOS/Windows and production boot fails.
    const targetFile = path.join(tmpDir, ".env");
    const linkPath = path.join(tmpDir, "app", ".env");
    await fs.writeFile(targetFile, "APP_SECRET=abcdefghijklmnopqrstuvwxyz012345", "utf8");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });

    await ensureSymlink(targetFile, linkPath, "file");

    const stat = await fs.lstat(linkPath);
    if (process.platform !== "win32") {
      expect(stat.isSymbolicLink()).toBe(true);
      // The linked content is the same file, so the secret is readable through it.
      expect(await fs.readFile(linkPath, "utf8")).toBe(
        await fs.readFile(targetFile, "utf8")
      );
    }
  });

  it("appends to profile idempotently without duplicating PATH entries", async () => {
    const profile = path.join(tmpDir, ".bashrc");
    const binDir = path.join(tmpDir, "bin");
    await fs.writeFile(profile, "# User bashrc\n", "utf8");

    const added1 = await addPathToProfile(binDir, profile);
    expect(added1).toBe(true);
    const content1 = await fs.readFile(profile, "utf8");
    expect(content1).toContain(binDir);

    const added2 = await addPathToProfile(binDir, profile);
    expect(added2).toBe(false); // Already present
    const occurrences = content1.split(binDir).length - 1;
    expect(occurrences).toBe(1);
  });
});
