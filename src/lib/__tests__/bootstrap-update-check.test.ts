import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const checkLatestVersionMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  current: "0.1.0",
  latest: "0.2.0",
  available: true,
  channel: "release",
  releaseUrl: "https://example.com/releases/tag/v0.2.0",
  checkedAt: Date.now(),
  errored: false,
}));

const createEventMock = vi.hoisted(() => vi.fn().mockReturnValue("evt_test"));

vi.mock("@/lib/system/version", () => ({
  checkLatestVersion: checkLatestVersionMock,
}));

vi.mock("@/lib/proactive/events", () => ({
  createProactiveEvent: vi.fn().mockResolvedValue("evt_test"),
  createProactiveEventIfNotRecent: createEventMock,
  generateProactiveEvents: vi.fn().mockResolvedValue({ created: 0, events: [] }),
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

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe("bootstrap startup update check", () => {
  beforeEach(() => {
    checkLatestVersionMock.mockClear();
    createEventMock.mockClear();
    // bootstrapAutonomousCognitiveSystem is idempotent via a globalThis flag;
    // reset it so each test exercises the full bootstrap (including the
    // async update announcement) rather than hitting the early-return guard.
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.__yggdrasilBootstrap;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("triggers checkLatestVersion asynchronously during bootstrap without throwing", async () => {
    const { bootstrapAutonomousCognitiveSystem } = await import("../bootstrap");

    // The queue runner and daemon are mocked above, so bootstrap never touches
    // this handle. It exists only to satisfy the required parameter.
    bootstrapAutonomousCognitiveSystem(undefined as never);

    // The check runs inside announceUpdateIfAvailable() (async).
    await flushMicrotasks();
    expect(checkLatestVersionMock).toHaveBeenCalled();
  });

  it("surfaces an available update as a proactive event in the notification center", async () => {
    const { bootstrapAutonomousCognitiveSystem } = await import("../bootstrap");

    bootstrapAutonomousCognitiveSystem(undefined as never);
    await flushMicrotasks();

    expect(createEventMock).toHaveBeenCalledTimes(1);
    const [input] = createEventMock.mock.calls[0] as [
      {
        kind: "reminder" | "system";
        title: string;
        body?: string | null;
        cooldownSeconds: number;
        titleContains: string;
      },
    ];
    expect(input.kind).toBe("system");
    expect(input.title).toContain("Update v0.2.0");
    expect(input.titleContains).toBe("Update v");
    // Cooldown keeps a given release from re-announcing every startup.
    expect(input.cooldownSeconds).toBeGreaterThanOrEqual(24 * 3600);
  });

  it("does not announce when no update is available", async () => {
    checkLatestVersionMock.mockResolvedValueOnce({
      current: "0.2.0",
      latest: "0.2.0",
      available: false,
      channel: "release",
      releaseUrl: null,
      checkedAt: Date.now(),
      errored: false,
    });
    const { bootstrapAutonomousCognitiveSystem } = await import("../bootstrap");

    bootstrapAutonomousCognitiveSystem(undefined as never);
    await flushMicrotasks();

    expect(createEventMock).not.toHaveBeenCalled();
  });
});
