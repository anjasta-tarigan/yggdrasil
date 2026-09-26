// src/cli/__tests__/format.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatDuration, panel, step, withSpinner, colorEnabled } from "../utils/format";

describe("CLI format helpers", () => {
  const logs: string[] = [];
  const originalLog = console.log;

  afterEach(() => {
    console.log = originalLog;
    logs.length = 0;
    vi.restoreAllMocks();
  });

  function capture(): void {
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  }

  it("formats durations across ms/s/min thresholds", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });

  it("emits plain text when stdout is not a TTY (pip install, CI, journals)", () => {
    // Vitest runs without a TTY, so colorEnabled() must be false here.
    expect(colorEnabled()).toBe(false);
    capture();
    step("Preparing directories", "5 dirs", 200);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe("✔ Preparing directories  5 dirs (200ms)");
    expect(logs[0]).not.toMatch(/\x1b\[/);
  });

  it("aligns panel borders regardless of row length", () => {
    capture();
    panel("Yggdrasil installed", [
      ["URL", "http://localhost:2302"],
      ["Data", "/home/u/.yggdrasil/data"],
      "",
      "Optional — configure after install:",
    ]);
    const widths = new Set(logs.map((line) => line.length));
    expect(widths.size).toBe(1);
    expect(logs[0]).toMatch(/^┌ ─+┐$/);
    expect(logs.at(-1)).toMatch(/^└ ─+┘$/);
  });

  it("resolves the spinner work and leaves no timer behind", async () => {
    capture();
    const result = await withSpinner("Registering systemd user unit…", Promise.resolve(42));
    expect(result).toBe(42);
    expect(logs[0]).toBe("… Registering systemd user unit…");
  });

  it("propagates rejection from the wrapped work", async () => {
    capture();
    await expect(
      withSpinner("Starting service…", Promise.reject(new Error("unit failed")))
    ).rejects.toThrow("unit failed");
  });
});
