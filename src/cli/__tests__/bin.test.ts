import { describe, it, expect } from "vitest";
import { runCommand } from "../utils/exec";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("CLI Executable Wrapper", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const binPath = path.resolve(__dirname, "../../../bin/yggdrasil.mjs");

  it("prints help when executed with --help", async () => {
    const res = await runCommand(process.execPath, [binPath, "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Yggdrasil System CLI");
    expect(res.stdout).toContain("install");
    expect(res.stdout).toContain("update");
  });

  /**
   * Regression: `install.sh`/`install.ps1` export NODE_ENV=production before
   * invoking this CLI, and `@/env` parses at import time and rejects a
   * production run without APP_SECRET — the very value the installer exists to
   * create. The CLI died with a ZodError before writing `.env`, so a fresh
   * production install never produced a secret.
   *
   * The commands must therefore avoid importing `@/env` entirely.
   *
   * `VITEST` must be cleared from the child env: `@/env` exempts test runs from
   * the APP_SECRET requirement, so leaving it set would hide the bug this test
   * exists to catch.
   */
  it("generates APP_SECRET when run with NODE_ENV=production and no secret set", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-bin-home-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-bin-target-"));
    try {
      const res = await runCommand(
        process.execPath,
        [binPath, "install", "--dir", target, "--no-service"],
        {
          // HOME is redirected so the CLI's ~/.local/bin symlink lands in a
          // temp dir instead of the developer's real one.
          env: { NODE_ENV: "production", HOME: home, APP_SECRET: "", VITEST: "" },
        }
      );

      expect(res.stderr).not.toContain("ZodError");
      expect(res.stdout).toContain("Yggdrasil installer");

      const envFile = await fs.readFile(path.join(target, ".env"), "utf8");
      const secret = /^APP_SECRET=(.+)$/m.exec(envFile)?.[1] ?? "";
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      // A release install must not carry the development-channel marker.
      expect(envFile).not.toContain("YGGDRASIL_CHANNEL");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * `install.sh`/`install.ps1` read YGGDRASIL_CHANNEL only to pick the checkout
   * ref and never persist it, so a main-channel install must record the marker
   * in `.env` itself — otherwise the running app has no way to tell a
   * development build from a release and reports a bogus "update available".
   */
  it("persists YGGDRASIL_CHANNEL=main into .env for a main-channel install", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-bin-home-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-bin-target-"));
    try {
      const res = await runCommand(
        process.execPath,
        [binPath, "install", "--dir", target, "--no-service"],
        {
          env: {
            NODE_ENV: "production",
            HOME: home,
            APP_SECRET: "",
            VITEST: "",
            YGGDRASIL_CHANNEL: "main",
          },
        }
      );

      expect(res.stderr).not.toContain("ZodError");
      const envFile = await fs.readFile(path.join(target, ".env"), "utf8");
      expect(envFile).toContain("YGGDRASIL_CHANNEL=main\n");
      expect(envFile).toMatch(/^PORT=\d+$/m);
      expect(envFile).toMatch(/^APP_SECRET=[0-9a-f]{64}$/m);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps uninstall working under NODE_ENV=production without a secret", async () => {
    // Recovery path: uninstall must run even when the install never produced a
    // secret, so it must not import the production-validated env schema either.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-bin-home-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-bin-target-"));
    try {
      const res = await runCommand(
        process.execPath,
        [binPath, "uninstall", "--dir", target],
        { env: { NODE_ENV: "production", HOME: home, APP_SECRET: "", VITEST: "" } }
      );

      expect(res.stderr).not.toContain("ZodError");
      expect(res.stdout).toContain("Uninstallation completed");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * Regression: a non-purge uninstall used to leave orphaned artifacts behind:
   *   1. The `export PATH=…` line in ~/.bashrc (the CLI symlink was removed but
   *      the shell rc entry was not).
   *   2. The `yggdrasil.pid` file (read for exit-wait, never deleted).
   *   3. The `bin/` directory holding platform service scripts (e.g. Windows
   *      start-background.ps1) — a sibling of app/ that was not removed.
   *
   * This test simulates a completed install's footprint and verifies every
   * artifact is cleaned up while user data (.env, data/) is preserved.
   */
  it("removes all install artifacts during non-purge uninstall, preserving user data", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-uninstall-home-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-uninstall-target-"));
    try {
      const localBin = path.join(home, ".local", "bin");

      if (process.platform !== "win32") {
        // Simulate installCliOnPath: symlink + PATH export in .bashrc.
        await fs.mkdir(localBin, { recursive: true });
        await fs.symlink(
          path.join(target, "app", "bin", "yggdrasil.mjs"),
          path.join(localBin, "yggdrasil"),
          "file"
        );
        const exportLine = `\n# Yggdrasil CLI PATH\nexport PATH="${localBin}:$PATH"\n`;
        await fs.writeFile(path.join(home, ".bashrc"), `# User bashrc\n${exportLine}`, "utf8");
      }

      // Simulate the PID file (always written by the service / Windows script).
      await fs.writeFile(path.join(target, "yggdrasil.pid"), "12345", "utf8");

      // User data that must survive a non-purge uninstall.
      await fs.mkdir(path.join(target, "data", "logs"), { recursive: true });
      await fs.writeFile(path.join(target, ".env"), "APP_SECRET=deadbeef\nPORT=2302\n", "utf8");

      // App + bin artifacts that must be removed.
      await fs.mkdir(path.join(target, "app", "bin"), { recursive: true });
      await fs.mkdir(path.join(target, "bin"), { recursive: true });
      await fs.writeFile(path.join(target, "bin", "start-background.ps1"), "# stub", "utf8");

      const res = await runCommand(
        process.execPath,
        [binPath, "uninstall", "--dir", target],
        { env: { NODE_ENV: "production", HOME: home, APP_SECRET: "", VITEST: "" } }
      );

      expect(res.stderr).not.toContain("ZodError");
      expect(res.stdout).toContain("Uninstallation completed");

      // — Artifacts that must be GONE —
      await expect(fs.access(path.join(target, "yggdrasil.pid"))).rejects.toThrow();
      await expect(fs.access(path.join(target, "app"))).rejects.toThrow();
      await expect(fs.access(path.join(target, "bin"))).rejects.toThrow();

      // — User data that must SURVIVE —
      await expect(fs.access(path.join(target, ".env"))).resolves.toBeUndefined();
      await expect(fs.access(path.join(target, "data", "logs"))).resolves.toBeUndefined();

      // Non-Windows: the symlink and the .bashrc PATH export must both be gone.
      if (process.platform !== "win32") {
        await expect(fs.access(path.join(localBin, "yggdrasil"))).rejects.toThrow();
        const bashrc = await fs.readFile(path.join(home, ".bashrc"), "utf8");
        expect(bashrc).not.toContain("# Yggdrasil CLI PATH");
        expect(bashrc).not.toContain(localBin);
        expect(bashrc).toContain("# User bashrc"); // pre-existing content survives
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * Regression: the systemd manager enables `loginctl enable-linger` during
   * install but previously never called `disable-linger` during uninstall.
   * The purge path must still wipe the entire baseDir.
   */
  it("purges the entire baseDir including data on --purge", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-purge-home-"));
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-purge-target-"));
    try {
      // Plant data that should NOT survive --purge.
      await fs.mkdir(path.join(target, "data", "models"), { recursive: true });
      await fs.writeFile(path.join(target, "yggdrasil.pid"), "99999", "utf8");

      const res = await runCommand(
        process.execPath,
        [binPath, "uninstall", "--dir", target, "--purge"],
        { env: { NODE_ENV: "production", HOME: home, APP_SECRET: "", VITEST: "" } }
      );

      expect(res.stderr).not.toContain("ZodError");
      expect(res.stdout).toContain("Uninstallation completed");
      expect(res.stdout).toContain("Purging entire directory");

      await expect(fs.access(target)).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    }
  }, 30_000);
});
