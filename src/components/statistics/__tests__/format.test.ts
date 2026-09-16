import { describe, it, expect } from "vitest";
import { formatBytes, formatUptime, formatWhen, formatCount } from "../format";

describe("statistics formatting helpers", () => {
  describe("formatUptime", () => {
    it("formats sub-minute seconds with seconds precision", () => {
      expect(formatUptime(0)).toBe("0s");
      expect(formatUptime(45)).toBe("45s");
    });

    it("formats sub-hour uptime with minutes and seconds", () => {
      expect(formatUptime(65)).toBe("1m 5s");
      expect(formatUptime(120)).toBe("2m 0s");
      expect(formatUptime(3599)).toBe("59m 59s");
    });

    it("formats hours and minutes when above 1 hour", () => {
      expect(formatUptime(3600)).toBe("1h 0m");
      expect(formatUptime(3665)).toBe("1h 1m");
      expect(formatUptime(7200)).toBe("2h 0m");
    });

    it("formats days, hours, and minutes when above 1 day", () => {
      expect(formatUptime(86400)).toBe("1d 0h 0m");
      expect(formatUptime(90061)).toBe("1d 1h 1m");
    });

    it("handles non-finite or negative values gracefully", () => {
      expect(formatUptime(-5)).toBe("0s");
      expect(formatUptime(Number.NaN)).toBe("0s");
    });
  });

  describe("formatBytes", () => {
    it("formats zero and negative bytes", () => {
      expect(formatBytes(0)).toBe("0 B");
      expect(formatBytes(-100)).toBe("0 B");
      expect(formatBytes(Number.NaN)).toBe("0 B");
    });

    it("formats small byte values as integer B", () => {
      expect(formatBytes(1)).toBe("1 B");
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1023)).toBe("1023 B");
    });

    it("formats kilobytes and megabytes with 1 decimal place", () => {
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
      expect(formatBytes(500 * 1024 * 1024)).toBe("500.0 MB");
    });

    it("prevents boundary rollover like 1024.0 KB by shifting to 1.0 MB", () => {
      // 1024 * 1024 - 10 = 1048566 bytes (~1023.99 KB)
      // Without rollover protection, toFixed(1) would print "1024.0 KB"
      expect(formatBytes(1024 * 1024 - 10)).toBe("1.0 MB");
    });

    it("formats gigabytes and terabytes", () => {
      expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
      expect(formatBytes(16 * 1024 ** 3)).toBe("16.0 GB");
      expect(formatBytes(2 * 1024 ** 4)).toBe("2.0 TB");
    });
  });

  describe("formatCount", () => {
    it("formats integers with locale grouping", () => {
      expect(formatCount(0)).toBe("0");
      expect(formatCount(1234)).toBe((1234).toLocaleString());
      expect(formatCount(1000000)).toBe((1000000).toLocaleString());
    });

    it("returns dash for non-finite numbers", () => {
      expect(formatCount(Number.NaN)).toBe("—");
      expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
    });
  });

  describe("formatWhen", () => {
    it("returns never for null or empty dates", () => {
      expect(formatWhen(null)).toBe("never");
      expect(formatWhen("")).toBe("never");
      expect(formatWhen("invalid-date")).toBe("never");
    });

    it("formats a valid ISO string", () => {
      const formatted = formatWhen("2025-06-01T12:00:00.000Z");
      expect(formatted).not.toBe("never");
      expect(formatted.length).toBeGreaterThan(0);
    });
  });
});
