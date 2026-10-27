import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  requirePowerShell,
  resolvePowerShell,
  resetPowerShellCache,
  PowerShellUnavailableError,
} from "../powershell";

describe("resolvePowerShell", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-pwsh-resolve-"));
    resetPowerShellCache();
  });

  afterEach(async () => {
    resetPowerShellCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const bareEnv = (extra: Record<string, string | undefined> = {}) => ({
    PATH: "",
    ProgramFiles: path.join(tempDir, "no-program-files"),
    LOCALAPPDATA: path.join(tempDir, "no-local-appdata"),
    ...extra,
  });

  it("prefers PowerShell 7 from PATH", async () => {
    const dir = path.join(tempDir, "bin");
    const pwsh = path.join(dir, "pwsh.exe");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(pwsh, "");

    const shell = resolvePowerShell(bareEnv({ PATH: dir }));

    expect(shell?.exe).toBe(pwsh);
    expect(shell?.name).toBe("pwsh.exe");
    expect(shell?.supportsAndAnd).toBe(true);
    expect(shell?.label).toBe("pwsh.exe (PowerShell 7+)");
  });

  it("finds a PowerShell 7 install that is not on PATH", async () => {
    const programFiles = path.join(tempDir, "Program Files");
    const pwsh = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
    await fs.mkdir(path.dirname(pwsh), { recursive: true });
    await fs.writeFile(pwsh, "");

    const shell = resolvePowerShell(bareEnv({ ProgramFiles: programFiles }));

    expect(shell?.exe).toBe(pwsh);
  });

  it("does not fall back to Windows PowerShell 5.1", () => {
    // Policy: 5.1 is rejected, not silently used. Nothing resolvable → null.
    expect(resolvePowerShell(bareEnv())).toBeNull();
  });

  it("rejects a YGGDRASIL_POWERSHELL override that points at powershell.exe", () => {
    const shell = resolvePowerShell(
      bareEnv({
        YGGDRASIL_POWERSHELL:
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      })
    );

    expect(shell).toBeNull();
  });

  it("honours a YGGDRASIL_POWERSHELL override that points at pwsh.exe", () => {
    const shell = resolvePowerShell(
      bareEnv({ YGGDRASIL_POWERSHELL: "C:\\Tools\\pwsh.exe" })
    );

    expect(shell?.exe).toBe("C:\\Tools\\pwsh.exe");
    expect(shell?.name).toBe("pwsh.exe");
  });
});

describe("requirePowerShell", () => {
  beforeEach(() => resetPowerShellCache());
  afterEach(() => resetPowerShellCache());

  it("throws an actionable error when PowerShell 7 is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ygg-pwsh-missing-"));
    try {
      await expect(
        requirePowerShell({
          PATH: "",
          ProgramFiles: path.join(tempDir, "no-program-files"),
          LOCALAPPDATA: path.join(tempDir, "no-local-appdata"),
        })
      ).rejects.toBeInstanceOf(PowerShellUnavailableError);
      await expect(
        requirePowerShell({
          PATH: "",
          ProgramFiles: path.join(tempDir, "no-program-files"),
          LOCALAPPDATA: path.join(tempDir, "no-local-appdata"),
        })
      ).rejects.toThrow(/winget install --id Microsoft\.PowerShell/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "accepts the pwsh.exe installed on this machine",
    async () => {
      const shell = await requirePowerShell();
      expect(shell.name).toBe("pwsh.exe");
    },
    60_000
  );
});
