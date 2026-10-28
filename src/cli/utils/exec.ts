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

    // Resolve on "exit", not "close".
    //
    // On Windows, the "close" event fires only after the child exits AND every
    // stdio file-descriptor has been closed. When runCommand spawns
    // powershell.exe to launch the background service (start-background.ps1),
    // that script uses Start-Process to detach a long-running yggdrasil-runtime.exe.
    // Due to Windows handle inheritance, the grandchild (yggdrasil-runtime.exe) can
    // inherit the pipe write-end handles from the PowerShell child, keeping
    // them open for the server's lifetime. Because "close" waits for those
    // handles to close, it never fires and runCommand hangs forever — the
    // installer freezes at "Starting service…".
    //
    // The "exit" event fires when the child terminates, regardless of whether
    // inherited handles are still open, so it reliably breaks the deadlock.
    // However, "exit" can fire before all buffered "data" events have been
    // emitted from the pipes. setImmediate yields one event-loop tick (after
    // the poll phase where I/O "data" events are delivered) so that any
    // remaining stdout/stderr is captured before we resolve.
    child.on("exit", (code) => {
      setImmediate(() => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}
