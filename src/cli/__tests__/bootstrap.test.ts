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

  it("install.ps1 surfaces download failures and reports clock skew", async () => {
    // Regression: the phase-1 catch replaced every transport error with
    // "Failed to download install.ps1 from release <tag>", hiding the cause. A
    // machine whose clock was 8 hours slow failed TLS ("certificate is not yet
    // valid") on github.com while raw.githubusercontent.com still worked, so the
    // installer looked broken for no visible reason. Keep the exception chain
    // and add the measurable, actionable hint.
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");
    const thrown =
      'throw "Failed to download install.ps1 from release $version (reason: $reason)"';

    expect(ps1).toContain("function Get-ClockSkewMinutes");
    expect(ps1).toContain("$_.Exception.Message");
    expect(ps1).toContain("Download failed: $reason");
    expect(ps1).toContain("w32tm /resync /force");
    expect(ps1).toContain(thrown);

    // Defined before the download it diagnoses.
    expect(ps1.indexOf("function Get-ClockSkewMinutes")).toBeLessThan(
      ps1.indexOf(thrown)
    );

    // The probe must stay on plain HTTP: the failure it diagnoses is TLS, so an
    // https:// probe would fail for the same reason it is investigating.
    const skewProbe = ps1.slice(ps1.indexOf("function Get-ClockSkewMinutes"));
    expect(skewProbe).toContain('"http://example.com"');
    expect(skewProbe).not.toContain('"https://example.com"');
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

    // ...but neither script writes the resolved tag into the child environment,
    // so an unpinned install stays on main instead of the frozen release tag.
    // A user pin is inherited by the child process because it is already
    // exported in the parent.
    expect(sh).not.toMatch(/^\s*export YGGDRASIL_VERSION=/m);
    expect(ps1).toContain('if ($env:YGGDRASIL_VERSION) {');
    // install.ps1 never writes the resolved tag back: Phase 2 reads the
    // variable only when the user pinned a release and otherwise uses main.
    expect(ps1).not.toMatch(/^\s*\$env:YGGDRASIL_VERSION\s*=/m);
  });

  it("install.ps1 selects TLS 1.3 without requiring a framework enum member", async () => {
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");

    expect(ps1.includes("[Net.SecurityProtocolType]::Tls13")).toBe(false);
    expect(ps1.includes("[Net.SecurityProtocolType]([int]12288)")).toBe(true);
  });

  it("install.ps1 adds common pnpm locations before its final availability check", async () => {
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");
    const pathUpdate = ps1.indexOf('"$env:APPDATA\\npm"');
    const missingPnpmError = ps1.indexOf('throw "Failed to locate or install pnpm.');

    expect(pathUpdate).toBeGreaterThanOrEqual(0);
    expect(pathUpdate).toBeLessThan(missingPnpmError);
  });

  it("install.ps1 uses encoded PowerShell commands for Windows build paths", async () => {
    const ps1 = await fs.readFile(path.join(root, "install.ps1"), "utf8");

    expect(ps1).toContain("[Text.Encoding]::Unicode.GetBytes($pwshCmd)");
    expect(ps1).toContain('"-NoLogo -NoProfile -EncodedCommand $encodedCommand"');
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
    // The build runs through `node scripts/build.mjs` (not `pnpm build`) so a
    // missing script cannot mask a build failure, and every failure path
    // reports through Fail-Step.
    expect(ps1).toContain("scripts/build.mjs");
    expect(ps1).toContain('Fail-Step "Next.js build"');

    // Policy: PowerShell 7+ only. A 5.1 host is stopped up front, and the build
    // child runs on the same pwsh.exe the app's agent shell uses.
    expect(ps1).toContain("$PSVersionTable.PSVersion.Major -lt 7");
    expect(ps1).toContain("$psi.FileName = $pwshExe");
    expect(ps1).not.toContain('$psi.FileName = "powershell.exe"');
    expect(ps1).toContain("winget install --id Microsoft.PowerShell");

    // The generated APP_SECRET is verified before the build so a missing/weak
    // secret fails the install loudly instead of aborting later on a ZodError.
    expect(ps1).toContain("Verifying APP_SECRET");
    expect(ps1).toContain('^[0-9a-f]{64}$');

    // The documented `irm ... | iex` invocation runs in the caller's PowerShell
    // host, so exit statements would close the user's terminal on success or failure.
    expect(ps1.includes("YGGDRASIL INSTALLATION FAILED")).toBe(true);
    expect(ps1.includes("installation complete")).toBe(true);
    expect(ps1).not.toMatch(/^\s*exit\s+/im);
    expect(ps1).toContain('throw "Installation failed during step: $Step"');
    expect(ps1).toContain("return");

    // Every critical step is exit-code-checked; there is no unguarded success.
    expect(ps1).toContain('Fail-Step "pnpm install"');
    expect(ps1).toContain('Fail-Step "Next.js build"');
    expect(ps1).toContain('Fail-Step "yggdrasil install"');
  });
});
