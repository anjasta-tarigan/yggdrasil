// src/lib/memory/__tests__/memory-pressure-monitor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted mocks — must be defined before vi.mock calls that reference them.
const { mockReleaseAll, mockIsLoaded } = vi.hoisted(() => ({
  mockReleaseAll: vi.fn().mockResolvedValue(undefined),
  mockIsLoaded: vi.fn().mockReturnValue(true),
}));

let _availableBytes = 2 * 1024 * 1024 * 1024;

vi.mock("../onnx-session", () => ({
  releaseAllOnnxSessions: mockReleaseAll,
  isOnnxSessionLoaded: mockIsLoaded,
}));

vi.mock("@/lib/system-memory", () => ({
  getAvailableMemoryBytes: () => _availableBytes,
}));

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
}));

import {
  startMemoryPressureMonitor,
  stopMemoryPressureMonitor,
  isMemoryPressureMonitorRunning,
  resetMemoryPressureMonitorForTest,
  runMemoryPressureCheckForTest,
} from "../memory-pressure-monitor";

describe("memory-pressure-monitor", () => {
  const DEFAULT_THRESHOLD_MB = 256;
  const DEFAULT_THRESHOLD_BYTES = DEFAULT_THRESHOLD_MB * 1024 * 1024;

  beforeEach(() => {
    resetMemoryPressureMonitorForTest();
    _availableBytes = 2 * 1024 * 1024 * 1024; // 2 GB — well above threshold
    mockReleaseAll.mockClear();
    mockIsLoaded.mockReturnValue(true);
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
});
