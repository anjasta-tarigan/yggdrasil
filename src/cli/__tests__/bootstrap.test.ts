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

  it("default install no longer forwards the resolved release tag to Phase 2", async () => {
    // Regression: the trampoline unconditionally exported the resolved latest
    // release tag into YGGDRASIL_VERSION, so every default install checked out the
    // frozen release tag instead of main — fixes merged into main never reached a
    // fresh install until the next tag. The export must now be guarded so an
    // unpinned install leaves YGGDRASIL_VERSION unset and checks out main.
    const sh = await fs.readFile(path.join(root, "install.sh"), "utf8");
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");

    // Each script still resolves the release (for the verification trampoline)...
    expect(sh).toContain("YGGDRASIL_VERSION");
    expect(ps1).toContain("YGGDRASIL_VERSION");

    // ...but the export of the resolved tag into the child environment is now
    // guarded by an explicit user-pin check, so the default path stays on main.
    expect(sh).toContain('[ -n "${YGGDRASIL_VERSION:-}" ]');
    expect(sh).toContain('export YGGDRASIL_VERSION="${VERSION}"');
    expect(ps1).toContain('if ($env:YGGDRASIL_VERSION) {');
    expect(ps1).toContain('$env:YGGDRASIL_VERSION = $version');
  });

  it("install.ps1 selects TLS 1.3 without requiring a framework enum member", async () => {
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");

    expect(ps1.includes("[Net.SecurityProtocolType]::Tls13")).toBe(false);
    expect(ps1.includes("[Net.SecurityProtocolType]([int]12288)")).toBe(true);
  });

  it("install.ps1 adds common pnpm locations before its final availability check", async () => {
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");
    const pathUpdate = ps1.indexOf('"$env:APPDATA\\npm"');
    const missingPnpmError = ps1.indexOf('Write-Error "Failed to locate or install pnpm.');

    expect(pathUpdate).toBeGreaterThanOrEqual(0);
    expect(pathUpdate).toBeLessThan(missingPnpmError);
  });

  it("install.ps1 uses encoded PowerShell commands for Windows build paths", async () => {
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");

    expect(ps1).toContain("[Text.Encoding]::Unicode.GetBytes($pwshCmd)");
    expect(ps1).toContain('"-NoProfile -EncodedCommand $encodedCommand"');
    expect(ps1).toContain('$quotedLogPath = $LogPath.Replace("\'", "\'\'")');
    expect(ps1).toContain("Tee-Object -FilePath '$quotedLogPath'");
    expect(ps1).toContain('build --single-worker 2>&1');
  });

  it("production build scripts invoke the Next.js build command", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

    expect(pkg.scripts.build).toContain("scripts/build.mjs build --single-worker");
    expect(pkg.scripts["build:ci"]).toContain("scripts/build.mjs build --heap=8192");
  });

  it("install.ps1 detects OS and reports success or failure explicitly", async () => {
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");
    const osGuard = ps1.indexOf("if ($IsLinux -or $IsMacOS)");
    const tlsConfig = ps1.indexOf("SecurityProtocol =");

    expect(osGuard).toBeGreaterThanOrEqual(0);
    expect(tlsConfig).toBeGreaterThan(osGuard);
    expect(tlsConfig).toBeLessThan(ps1.indexOf("$GithubOwnerRepo ="));

    // OS guard: route non-Windows users to install.sh before any download.
    expect(ps1).toContain("install.sh");
    expect(ps1).toContain("$IsLinux");
    expect(ps1).toContain("$IsMacOS");

    // A hung `next build` must not stall the installer forever: the build is run
    // through a wall-clock timeout (YGGDRASIL_BUILD_TIMEOUT) that kills the whole
    // pnpm -> node tree on expiry.
    expect(ps1).toContain("YGGDRASIL_BUILD_TIMEOUT");
    expect(ps1).toContain("Invoke-BuildWithTimeout");
    expect(ps1).toContain('Fail-Step "pnpm build"');

    // The generated APP_SECRET is verified before the build so a missing/weak
    // secret fails the install loudly instead of aborting later on a ZodError.
    expect(ps1).toContain("Verifying APP_SECRET");
    expect(ps1).toContain('^[0-9a-f]{64}$');

    // Staged flow: a failed step must surface a FAILURE banner and exit 1, and
    // the success panel must be unreachable except via exit 0.
    expect(ps1.includes("YGGDRASIL INSTALLATION FAILED")).toBe(true);
    expect(ps1.includes("installation complete")).toBe(true);
    expect(ps1.includes("exit 1")).toBe(true);
    expect(ps1.includes("exit 0")).toBe(true);

    // Every critical step is exit-code-checked; there is no unguarded success.
    expect(ps1).toContain('Fail-Step "pnpm install"');
    expect(ps1).toContain('Fail-Step "pnpm build"');
    expect(ps1).toContain('Fail-Step "yggdrasil install"');
  });
});
