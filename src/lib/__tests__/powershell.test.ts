import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolvePowerShell, resetPowerShellCache } from "../powershell";

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
    SystemRoot: "D:\\Windows",
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

    expect(shell.exe).toBe(pwsh);
    expect(shell.name).toBe("pwsh.exe");
    expect(shell.edition).toBe("core");
    expect(shell.supportsAndAnd).toBe(true);
    expect(shell.label).toBe("pwsh.exe (PowerShell 7+)");
  });

  it("finds a PowerShell 7 install that is not on PATH", async () => {
    const programFiles = path.join(tempDir, "Program Files");
    const pwsh = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
    await fs.mkdir(path.dirname(pwsh), { recursive: true });
    await fs.writeFile(pwsh, "");

    const shell = resolvePowerShell(bareEnv({ ProgramFiles: programFiles }));

    expect(shell.exe).toBe(pwsh);
    expect(shell.edition).toBe("core");
  });

  it("falls back to Windows PowerShell 5.1 when pwsh is absent", () => {
    const shell = resolvePowerShell(bareEnv());

    expect(shell.exe).toBe(
      path.join("D:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    );
    expect(shell.name).toBe("powershell.exe");
    expect(shell.edition).toBe("desktop");
    expect(shell.supportsAndAnd).toBe(false);
    expect(shell.label).toBe("powershell.exe (Windows PowerShell 5.1)");
  });

  it("honours the YGGDRASIL_POWERSHELL override", () => {
    const shell = resolvePowerShell(
      bareEnv({ YGGDRASIL_POWERSHELL: "C:\\Tools\\pwsh.exe" })
    );

    expect(shell.exe).toBe("C:\\Tools\\pwsh.exe");
    expect(shell.name).toBe("pwsh.exe");
    expect(shell.supportsAndAnd).toBe(true);
  });

  it("defaults SystemRoot to C:\\Windows when the env omits it", () => {
    const shell = resolvePowerShell({
      PATH: "",
      ProgramFiles: path.join(tempDir, "no-program-files"),
      LOCALAPPDATA: path.join(tempDir, "no-local-appdata"),
    });

    expect(shell.exe.toLowerCase()).toContain("c:\\windows\\system32");
  });
});
