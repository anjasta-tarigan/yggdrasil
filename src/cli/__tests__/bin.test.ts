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
      expect(res.stdout).toContain("Setting up installation");

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
});
