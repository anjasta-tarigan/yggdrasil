import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";

const checkLatestVersionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: checkLatestVersionMock,
  GITHUB_RELEASES_PAGE_URL: "https://github.com/anjasta-tarigan/yggdrasil/releases",
}));

import { checkUpdateCommand } from "../commands/check-update";
import { parseCliArgs } from "../index";

describe("yggdrasil check-update CLI command", () => {
  let logSpy: MockInstance<typeof console.log>;
  let errorSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("parses check-update subcommand in CLI arguments", () => {
    const parsed = parseCliArgs(["check-update"]);
    expect(parsed.command).toBe("check-update");
  });

  it("prints update available and sets exitCode to 1 when a newer release exists", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      releaseUrl: "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
      errored: false,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(1);
    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("Update available: v0.2.0");
    expect(logs).toContain("yggdrasil update");
  });

  it("prints the releases page when a stale-cache result carries an empty releaseUrl", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: "0.2.0",
      available: true,
      channel: "release",
      // The cache stores `releaseUrl ?? ""`; a stale-cache hit yields "".
      releaseUrl: "",
      errored: false,
    });

    await checkUpdateCommand({});

    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("https://github.com/anjasta-tarigan/yggdrasil/releases");
    expect(logs).not.toContain("visit  to update");
  });

  it("prints up-to-date and sets exitCode to 0 when no newer release exists", async () => {    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.2.0",
      latest: "0.2.0",
      available: false,
      channel: "release",
      releaseUrl: null,
      errored: false,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(0);
    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("Yggdrasil is up to date (v0.2.0)");
  });

  it("prints development message and sets exitCode to 0 when on main channel", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0-dev",
      latest: null,
      available: false,
      channel: "main",
      releaseUrl: null,
      errored: false,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(0);
    const logs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logs).toContain("main branch (development build)");
  });

  it("prints error and sets exitCode to 2 when check errored", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.1.0",
      latest: null,
      available: false,
      channel: "release",
      releaseUrl: null,
      errored: true,
    });

    await checkUpdateCommand({});

    expect(process.exitCode).toBe(2);
    const errors = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(errors).toContain("Could not verify the latest release");
  });
});
