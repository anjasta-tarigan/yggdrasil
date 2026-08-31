import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "../relative-time";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// Fixed "now" so assertions are deterministic regardless of test runtime.
const NOW = Date.parse("2025-06-15T12:00:00Z");

describe("formatRelativeTime", () => {
  it("shows 'just now' for anything under a minute old", () => {
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW, NOW)).toBe("just now");
  });

  it("uses minutes under an hour", () => {
    expect(formatRelativeTime(NOW - 1 * MIN, NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(NOW - 59 * MIN, NOW)).toBe("59 minutes ago");
  });

  it("uses hours under a day", () => {
    expect(formatRelativeTime(NOW - 1 * HOUR, NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
    expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe("23 hours ago");
  });

  it("uses days under a week", () => {
    expect(formatRelativeTime(NOW - 1 * DAY, NOW)).toBe("yesterday");
    expect(formatRelativeTime(NOW - 2 * DAY, NOW)).toBe("2 days ago");
    expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe("6 days ago");
  });

  it("uses weeks under 30 days", () => {
    expect(formatRelativeTime(NOW - 1 * WEEK, NOW)).toBe("last week");
    expect(formatRelativeTime(NOW - 3 * WEEK, NOW)).toBe("3 weeks ago");
  });

  it("falls back to an absolute short date past a month", () => {
    expect(formatRelativeTime(NOW - 45 * DAY, NOW)).toBe("May 1");
  });

  it("handles timestamps exactly on unit boundaries", () => {
    expect(formatRelativeTime(NOW - MIN, NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(NOW - HOUR, NOW)).toBe("1 hour ago");
    expect(formatRelativeTime(NOW - DAY, NOW)).toBe("yesterday");
  });
});
