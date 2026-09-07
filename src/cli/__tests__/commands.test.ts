// src/cli/__tests__/commands.test.ts
import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../index";

describe("CLI Argument Parser and Command Dispatcher", () => {
  it("parses install options with defaults", () => {
    const parsed = parseCliArgs(["install"]);
    expect(parsed.command).toBe("install");
    expect(parsed.options.port).toBe(2302);
    expect(parsed.options.noService).toBe(false);
  });

  it("parses custom port and flags", () => {
    const parsed = parseCliArgs(["install", "--port", "8080", "--no-service", "--yes"]);
    expect(parsed.command).toBe("install");
    expect(parsed.options.port).toBe(8080);
    expect(parsed.options.noService).toBe(true);
    expect(parsed.options.yes).toBe(true);
  });

  it("parses uninstall purge flag", () => {
    const parsed = parseCliArgs(["uninstall", "--purge", "-y"]);
    expect(parsed.command).toBe("uninstall");
    expect(parsed.options.purge).toBe(true);
    expect(parsed.options.yes).toBe(true);
  });

  it("parses service lifecycle subcommands", () => {
    expect(parseCliArgs(["start"]).command).toBe("start");
    expect(parseCliArgs(["stop"]).command).toBe("stop");
    expect(parseCliArgs(["restart"]).command).toBe("restart");
    expect(parseCliArgs(["status"]).command).toBe("status");
    expect(parseCliArgs(["logs"]).command).toBe("logs");
  });
});
