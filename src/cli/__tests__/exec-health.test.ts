import { describe, it, expect, vi } from "vitest";
import { runCommand } from "../utils/exec";
import { waitForHealth, waitForProcessExit } from "../utils/health";

describe("Execution and Health Check Utilities", () => {
  it("executes basic commands and captures output", async () => {
    const res = await runCommand(process.execPath, ["-e", "console.log('hello yggdrasil')"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hello yggdrasil");
  });

  it("handles non-zero exit codes cleanly", async () => {
    const res = await runCommand(process.execPath, ["-e", "process.exit(2)"]);
    expect(res.code).toBe(2);
  });

  it("waits for health check successfully when endpoint returns 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
    });
    global.fetch = fetchMock;

    const healthy = await waitForHealth("http://localhost:2302/api/health", 1000, 50);
    expect(healthy).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns false if health check times out", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
    const healthy = await waitForHealth("http://localhost:2302/api/health", 200, 50);
    expect(healthy).toBe(false);
  });

  it("detects process exit when process is no longer running", async () => {
    // Non-existent PID
    const exited = await waitForProcessExit(99999999, 500);
    expect(exited).toBe(true);
  });
});
