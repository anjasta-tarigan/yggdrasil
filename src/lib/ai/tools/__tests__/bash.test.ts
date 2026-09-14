// src/lib/ai/tools/__tests__/bash.test.ts
import { describe, it, expect } from "vitest";
import { bash } from "../bash";
import { builtinTools } from "../index";

describe("bash Tool & Registry Integration", () => {
  it("is registered as a builtin tool with an execute function", () => {
    expect(builtinTools).toHaveProperty("bash");
    expect(builtinTools.bash).toBe(bash);
    expect(typeof bash.execute).toBe("function");
    expect(bash.inputSchema).toBeDefined();
  });

  it("executes a simple read-only command and returns structured output", async () => {
    const res = await bash.execute!({ command: "echo hello-bash" }, {} as never);
    expect(res).toHaveProperty("exitCode", 0);
    expect((res as { stdout: string }).stdout).toContain("hello-bash");
  });

  it("returns a structured error result (never throws) for a missing command", async () => {
    const res = await bash.execute!(
      { command: "this-command-does-not-exist-xyz" },
      {} as never
    );
    const result = res as { stdout: string; stderr: string; exitCode: number };
    expect(result.exitCode).toBe(127);
    expect(result.stderr).not.toContain("thrown");
  });

  it("blocks dangerous commands through the host sandbox speed bumps", async () => {
    const res = await bash.execute!({ command: "sudo ls" }, {} as never);
    const result = res as { stdout: string; stderr: string; exitCode: number };
    // assertSafeCommand throws before any process is spawned; the tool
    // converts that into a structured failure (exit 126).
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toMatch(/Blocked command/);
  });

  it("runs in the sandbox workspace, not the workspace root", async () => {
    const res = (await bash.execute!({ command: "pwd" }, {} as never)) as {
      stdout: string;
      exitCode: number;
    };
    expect(res.exitCode).toBe(0);
    // SANDBOX_ROOT is data/sandbox under the server cwd.
    expect(res.stdout.trim()).toMatch(/sandbox$/);
  });
});
