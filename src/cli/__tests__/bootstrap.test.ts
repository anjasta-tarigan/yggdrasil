// src/cli/__tests__/bootstrap.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("Bootstrap Installer Scripts", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, "../../../");

  it("install.sh exists, is executable, and contains sha256 checksum check", async () => {
    const shPath = path.join(root, "install.sh");
    const content = await fs.readFile(shPath, "utf8");
    expect(content).toContain("sha256sum");
    expect(content).toContain("yggdrasil");
    if (process.platform !== "win32") {
      const mode = (await fs.stat(shPath)).mode;
      expect(mode & 0o111).not.toBe(0);
    }
  });

  it("install.ps1 exists and contains SHA256 Get-FileHash check", async () => {
    const ps1Path = path.join(root, "install.ps1");
    const content = await fs.readFile(ps1Path, "utf8");
    expect(content).toContain("Get-FileHash");
    expect(content).toContain("SHA256");
  });

  it("both scripts implement the release SHA-256 verification gate", async () => {
    // Spec §3: resolve latest release tag (or YGGDRASIL_VERSION), download the
    // installer + .sha256 companion from release assets, verify, and abort
    // loudly on mismatch. Guards against the gate being deleted while a stray
    // "sha256sum" mention keeps the marker tests above green.
    const sh = await fs.readFile(path.join(root, "install.sh"), "utf8");
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");

    for (const script of [sh, ps1]) {
      expect(script).toContain("Checksum verification failed");
      expect(script).toContain("YGGDRASIL_VERSION");
      expect(script).toContain("releases/latest");
    }
    expect(sh).toContain("install.sh.sha256");
    expect(sh).toContain("YGGDRASIL_CHANNEL");
    expect(ps1).toContain("install.ps1.sha256");
  });
});
