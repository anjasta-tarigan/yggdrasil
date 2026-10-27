import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  windowsHide?: boolean;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(cmd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout,
      windowsHide: options.windowsHide,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Use "exit" — not "close" — to resolve the promise.
    //
    // On Windows, the "close" event fires only after the child process exits
    // AND every stdio file-descriptor has been closed. When runCommand spawns
    // powershell.exe to launch the background service (start-background.ps1),
    // that script uses Start-Process to detach a long-running yggdrasil.exe.
    // Due to Windows handle inheritance, the grandchild (yggdrasil.exe) can
    // inherit the pipe write-end handles from the PowerShell child, keeping
    // them open for the lifetime of the server. Because "close" waits for
    // those handles to close, it never fires and runCommand hangs forever —
    // the installer then freezes at "Starting service…".
    //
    // The "exit" event fires when the child process terminates, regardless of
    // whether inherited handles are still open. All stdout/stderr data is
    // delivered via "data" events before the child exits, so switching to
    // "exit" is safe and fixes the deadlock for any command that may spawn
    // background children.
    child.on("exit", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}
