import { beforeEach, describe, expect, it, vi } from "vitest";

const getRun = vi.fn();
vi.mock("workflow/api", () => ({ getRun: (...args: unknown[]) => getRun(...args) }));

import { cancelProjectRuns } from "../project-run-lifecycle";

describe("cancelProjectRuns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels each live run once and skips stale or completed runs", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    getRun.mockImplementation((runId: string) => ({
      exists: Promise.resolve(runId !== "stale"),
      status: Promise.resolve(runId === "finished" ? "completed" : "running"),
      cancel,
    }));

    await cancelProjectRuns([
      { activeRunId: "live" },
      { activeRunId: "live" },
      { activeRunId: "stale" },
      { activeRunId: "finished" },
    ]);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getRun).toHaveBeenCalledTimes(3);
  });

  it("propagates cancellation errors so callers can preserve owned rows", async () => {
    const failure = new Error("workflow store unavailable");
    getRun.mockReturnValue({
      exists: Promise.resolve(true),
      status: Promise.resolve("running"),
      cancel: vi.fn().mockRejectedValue(failure),
    });

    await expect(cancelProjectRuns([{ activeRunId: "live" }])).rejects.toBe(failure);
  });
});
