import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkLatestVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  current: "0.1.0",
  latest: "0.2.0",
  available: true,
  channel: "release",
  releaseUrl: "https://example.com",
  checkedAt: Date.now(),
  errored: false,
}));

vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: checkLatestVersionMock,
}));

vi.mock("@/lib/queue/runner", () => ({
  registerJobHandler: vi.fn(),
  startQueueRunner: vi.fn(),
  stopQueueRunner: vi.fn(),
}));

vi.mock("@/lib/daemon/scheduler", () => ({
  initCognitiveDaemon: vi.fn(),
  stopCognitiveDaemon: vi.fn(),
}));

describe("bootstrap startup update check", () => {
  beforeEach(() => {
    checkLatestVersionMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers checkLatestVersion asynchronously during bootstrap without throwing", async () => {
    const { bootstrapAutonomousCognitiveSystem } = await import("../bootstrap");

    // The queue runner and daemon are mocked above, so bootstrap never touches
    // this handle. It exists only to satisfy the required parameter.
    bootstrapAutonomousCognitiveSystem(undefined as never);

    expect(checkLatestVersionMock).toHaveBeenCalled();
  });
});
