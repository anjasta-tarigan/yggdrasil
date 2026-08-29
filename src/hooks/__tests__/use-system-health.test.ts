import { describe, it, expect } from "vitest";
import {
  getClockSkewMs,
  type SystemHealth,
} from "../use-system-health";

describe("getClockSkewMs", () => {
  it("returns null when serverNow is missing", () => {
    const health: SystemHealth = { status: "ok", checkedAt: Date.now() };
    expect(getClockSkewMs(health)).toBeNull();
  });

  it("returns null when checkedAt is missing", () => {
    const health: SystemHealth = {
      status: "ok",
      serverNow: new Date().toISOString(),
    };
    expect(getClockSkewMs(health)).toBeNull();
  });

  it("returns null for unparseable serverNow", () => {
    const health: SystemHealth = {
      status: "ok",
      checkedAt: Date.now(),
      serverNow: "not a date",
    };
    expect(getClockSkewMs(health)).toBeNull();
  });

  it("measures positive skew when server clock is ahead", () => {
    const checkedAt = 1_700_000_000_000;
    const health: SystemHealth = {
      status: "ok",
      checkedAt,
      serverNow: new Date(checkedAt + 5_000).toISOString(),
    };
    expect(getClockSkewMs(health)).toBe(5_000);
  });

  it("measures negative skew when browser clock is ahead", () => {
    const checkedAt = 1_700_000_000_000;
    const health: SystemHealth = {
      status: "ok",
      checkedAt,
      serverNow: new Date(checkedAt - 2_500).toISOString(),
    };
    expect(getClockSkewMs(health)).toBe(-2_500);
  });

  it("returns ~0 for synchronized clocks (within latency)", () => {
    const checkedAt = 1_700_000_000_000;
    const health: SystemHealth = {
      status: "ok",
      checkedAt,
      serverNow: new Date(checkedAt + 300).toISOString(),
    };
    expect(Math.abs(getClockSkewMs(health)!)).toBeLessThan(1000);
  });
});
