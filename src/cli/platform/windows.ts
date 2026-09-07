import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../utils/exec";
import type { InstallPaths } from "../types";
import type { ServiceManager } from "./index";

export function generateWindowsTaskCommand(): string {
  return `schtasks /Create /TN "Yggdrasil" /SC ONLOGON /TR "powershell.exe -NoProfile -WindowStyle Hidden -File \\"%USERPROFILE%\\.yggdrasil\\bin\\start-background.ps1\\"" /RL LIMITED /F`;
}

export class WindowsManager implements ServiceManager {
  async installService(paths: InstallPaths): Promise<void> {
    await fs.mkdir(paths.binDir, { recursive: true });
    const psScript = path.join(paths.binDir, "start-background.ps1");
    const scriptContent = `
Set-Location "$env:USERPROFILE\\.yggdrasil\\app"
$proc = Start-Process pnpm -ArgumentList "start" -RedirectStandardOutput "..\\data\\logs\\yggdrasil.log" -RedirectStandardError "..\\data\\logs\\yggdrasil.err.log" -PassThru -WindowStyle Hidden
$proc.Id | Out-File "..\\yggdrasil.pid" -Encoding ascii
`;
    await fs.writeFile(psScript, scriptContent.trim(), "utf8");
    await runCommand("cmd.exe", ["/c", generateWindowsTaskCommand()]);
  }

  async uninstallService(): Promise<void> {
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
    await runCommand("schtasks", ["/Delete", "/TN", "Yggdrasil", "/F"]);
  }

  async start(): Promise<void> {
    await runCommand("schtasks", ["/Run", "/TN", "Yggdrasil"]);
  }

  async stop(): Promise<void> {
    await runCommand("schtasks", ["/End", "/TN", "Yggdrasil"]);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async status(): Promise<{ active: boolean; details?: string }> {
    const res = await runCommand("schtasks", ["/Query", "/TN", "Yggdrasil", "/FO", "LIST"]);
    const active = res.stdout.includes("Running");
    return { active, details: res.stdout };
  }
}
