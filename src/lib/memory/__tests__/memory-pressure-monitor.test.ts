// src/lib/memory/__tests__/memory-pressure-monitor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted mocks — must be defined before vi.mock calls that reference them.
const { mockReleaseAll, mockIsLoaded, mockStopAllGguf } = vi.hoisted(() => ({
  mockReleaseAll: vi.fn().mockResolvedValue(undefined),
  mockIsLoaded: vi.fn().mockReturnValue(true),
  mockStopAllGguf: vi.fn().mockReturnValue(0),
}));

let _availableBytes = 2 * 1024 * 1024 * 1024;

vi.mock("../onnx-session", () => ({
  releaseAllOnnxSessions: mockReleaseAll,
  isOnnxSessionLoaded: mockIsLoaded,
}));

vi.mock("@/lib/llama/runner", () => ({
  stopAllGgufServers: mockStopAllGguf,
}));

vi.mock("@/lib/system-memory", () => ({
  getAvailableMemoryBytes: () => _availableBytes,
}));

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
}));

// env is parsed once at import, so stubEnv cannot reach it. Mock it instead so
// each test controls the effective threshold.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { YGGDRASIL_MEMORY_PRESSURE_THRESHOLD_MB: 256 as number | undefined },
}));
vi.mock("@/env", () => ({ env: mockEnv }));

import {
  startMemoryPressureMonitor,
  stopMemoryPressureMonitor,
  isMemoryPressureMonitorRunning,
  resetMemoryPressureMonitorForTest,
  runMemoryPressureCheckForTest,
} from "../memory-pressure-monitor";

describe("memory-pressure-monitor", () => {
  // Pin the threshold so the derived default (10% of RAM) never leaks in.
  const DEFAULT_THRESHOLD_MB = 256;
  const DEFAULT_THRESHOLD_BYTES = DEFAULT_THRESHOLD_MB * 1024 * 1024;

  beforeEach(() => {
    mockEnv.YGGDRASIL_MEMORY_PRESSURE_THRESHOLD_MB = DEFAULT_THRESHOLD_MB;
    resetMemoryPressureMonitorForTest();
    _availableBytes = 2 * 1024 * 1024 * 1024; // 2 GB — well above threshold
    mockReleaseAll.mockClear();
    mockIsLoaded.mockReturnValue(true);
    mockStopAllGguf.mockClear();
    mockStopAllGguf.mockReturnValue(0);
  });

  afterEach(() => {
    stopMemoryPressureMonitor();
  });

  it("does not release sessions when memory is healthy", async () => {
    await runMemoryPressureCheckForTest();
    expect(mockReleaseAll).not.toHaveBeenCalled();
  });

  it("releases ONNX sessions when available memory drops below threshold", async () => {
    _availableBytes = 100 * 1024 * 1024; // 100 MB — far below 256 MB threshold
    await runMemoryPressureCheckForTest();
    expect(mockReleaseAll).toHaveBeenCalledTimes(1);
  });

  it("does not release sessions when nothing is loaded", async () => {
    _availableBytes = 100 * 1024 * 1024;
    mockIsLoaded.mockReturnValue(false);
    await runMemoryPressureCheckForTest();
    expect(mockReleaseAll).not.toHaveBeenCalled();
  });

  it("tracks running state via start/stop", () => {
    expect(isMemoryPressureMonitorRunning()).toBe(false);
    startMemoryPressureMonitor();
    expect(isMemoryPressureMonitorRunning()).toBe(true);
    stopMemoryPressureMonitor();
    expect(isMemoryPressureMonitorRunning()).toBe(false);
  });

  it("startMemoryPressureMonitor is idempotent", () => {
    startMemoryPressureMonitor();
    startMemoryPressureMonitor();
    expect(isMemoryPressureMonitorRunning()).toBe(true);
  });

  it("does not release when memory is exactly at threshold", async () => {
    _availableBytes = DEFAULT_THRESHOLD_BYTES; // exactly at threshold
    await runMemoryPressureCheckForTest();
    expect(mockReleaseAll).not.toHaveBeenCalled();
  });

  it("releases when memory is 1 byte below threshold", async () => {
    _availableBytes = DEFAULT_THRESHOLD_BYTES - 1;
    await runMemoryPressureCheckForTest();
    expect(mockReleaseAll).toHaveBeenCalledTimes(1);
  });

  it("stops llama-servers under pressure even with no ONNX session loaded", async () => {
    _availableBytes = 100 * 1024 * 1024;
    mockIsLoaded.mockReturnValue(false);
    mockStopAllGguf.mockReturnValue(1);
    await runMemoryPressureCheckForTest();
    expect(mockStopAllGguf).toHaveBeenCalledTimes(1);
    expect(mockReleaseAll).not.toHaveBeenCalled();
  });

  it("derives 10% of total RAM when the env var is unset", async () => {
    mockEnv.YGGDRASIL_MEMORY_PRESSURE_THRESHOLD_MB = undefined;
    const { totalmem } = await import("node:os");
    const expected = Math.max(512, Math.round(totalmem() * 0.1 / (1024 * 1024)));
    // One byte below the derived threshold must fire; at it must not.
    _availableBytes = expected * 1024 * 1024;
    await runMemoryPressureCheckForTest();
    expect(mockReleaseAll).not.toHaveBeenCalled();
    _availableBytes = expected * 1024 * 1024 - 1;
    await runMemoryPressureCheckForTest();
    expect(mockReleaseAll).toHaveBeenCalledTimes(1);
  });
});
