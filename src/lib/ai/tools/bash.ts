// src/lib/ai/tools/bash.ts
import { tool } from "ai";
import { z } from "zod";
import { createHostSandbox } from "@/lib/sandbox/host-sandbox";
import { syslog } from "@/lib/observability/log-store";

/**
 * Sandbox bash execution tool (built-in).
 *
 * Runs a bash command inside the persistent sandbox workspace
 * (`data/sandbox`) and returns the captured stdout/stderr and exit code.
 *
 * Security is delegated to the host sandbox (lib/sandbox/host-sandbox.ts)
 * rather than re-implemented here, so there is a single audited layer of
 * guardrails:
 *  - `assertSafeCommand` blocks catastrophic patterns (sudo, recursive rm of
 *    /, device writes, piping remote scripts into a shell, power commands)
 *  - the process runs detached in its own process group, cwd = SANDBOX_ROOT,
 *    with a stripped environment and a 30s timeout that escalates
 *    SIGTERM → SIGKILL (survives commands that trap/ignore SIGTERM)
 *  - output is capped to a bounded character window
 *
 * Results are returned as structured output (never thrown) so the model can
 * see failures and recover. Destructive invocations are additionally gated
 * by the approval policy in lib/ai/tool-policy.ts, which marks commands
 * like `rm -rf`, package installs, and `kill` as requiring user-approval.
 *
 * `bash` is registered here as a built-in so it is part of `typeof chatTools`
 * (type-safe on the client), toggleable via Settings → Tools, and visible to
 * the prepare-step withholding and MCP collision layers — while remaining
 * sandbox-confined and a non-releasable collision target in the MCP manager.
 */
const sandbox = createHostSandbox();

export const bash = tool({
  description:
    "Run a bash command inside the persistent sandbox workspace (data/sandbox). The working directory is the sandbox root and files created there persist between turns. Use for computations, running or testing code, data processing, and quick experiments. 30 second timeout; blocked: sudo, device writes, recursive deletes of /, piping remote scripts into a shell.",
  inputSchema: z.object({
    command: z
      .string()
      .min(1)
      .max(4000)
      .describe("The bash command to execute"),
  }),
  execute: async ({ command }) => {
    try {
      return await sandbox.executeCommand(command);
    } catch (err) {
      syslog("error", "bash", `Command execution failed: ${err}`);
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 126,
      };
    }
  },
});
