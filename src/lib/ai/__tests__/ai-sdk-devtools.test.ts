import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Tests for getDevToolsInstance().
 *
 * TDD RED phase: this file imports from ../ai-sdk-devtools which does
 * not exist yet, so the entire suite should fail at import time.
 */

// Import the function under test (module intentionally absent for RED phase)
import { getDevToolsInstance } from "../ai-sdk-devtools";

describe("getDevToolsInstance", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns undefined when NODE_ENV is production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_SDK_DEVTOOLS_ENABLED", "true");

    expect(getDevToolsInstance()).toBeUndefined();
  });

  it("returns undefined when NODE_ENV is development but AI_SDK_DEVTOOLS_ENABLED is unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_SDK_DEVTOOLS_ENABLED", "");

    expect(getDevToolsInstance()).toBeUndefined();
  });

  it("returns undefined when NODE_ENV is development but AI_SDK_DEVTOOLS_ENABLED is false", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_SDK_DEVTOOLS_ENABLED", "false");

    expect(getDevToolsInstance()).toBeUndefined();
  });

  it("returns a DevToolsTelemetry instance when both env vars are set correctly", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_SDK_DEVTOOLS_ENABLED", "true");

    const instance = getDevToolsInstance();

    expect(instance).toBeDefined();
    expect(instance).not.toBeNull();
  });

  it("returns an instance with the expected telemetry callback methods", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_SDK_DEVTOOLS_ENABLED", "true");

    const instance = getDevToolsInstance();

    expect(instance).toBeDefined();
    // The Telemetry interface contract — these are the callbacks DevToolsTelemetry
    // populates to hook into every generation call.
    expect(typeof instance?.onStart).toBe("function");
    expect(typeof instance?.onStepStart).toBe("function");
    expect(typeof instance?.onStepEnd).toBe("function");
    expect(typeof instance?.onEnd).toBe("function");
    expect(typeof instance?.onError).toBe("function");
    expect(typeof instance?.executeTool).toBe("function");
  });

  it("is idempotent: calling twice returns equivalent instances", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AI_SDK_DEVTOOLS_ENABLED", "true");

    const first = getDevToolsInstance();
    const second = getDevToolsInstance();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The Telemetry interface is structurally identical on each call.
    const firstKeys = Object.keys(first ?? {});
    const secondKeys = Object.keys(second ?? {});
    expect(firstKeys).toEqual(secondKeys);
    expect(firstKeys.length).toBeGreaterThan(0);
  });
});
