// src/lib/ai/tools/__tests__/system.test.ts
import { describe, it, expect } from "vitest";
import { host_info } from "../system";
import { builtinTools } from "../index";

describe("host_info Tool & Registry Integration", () => {
  it("returns host OS, resource metrics, and tool availability", async () => {
    const res = (await host_info.execute!({}, {} as never)) as {
      os: { platform: string; arch: string };
      resources: { totalMemMb: number; cpus: number };
      tools: { hasEza: boolean };
    };

    expect(res.os).toHaveProperty("platform");
    expect(res.os).toHaveProperty("arch");
    expect(res.resources.cpus).toBeGreaterThan(0);
    expect(res.resources.totalMemMb).toBeGreaterThan(0);
    expect(typeof res.tools.hasEza).toBe("boolean");
  });

  it("exports file_operations, notify_user, and host_info in builtinTools", () => {
    expect(builtinTools).toHaveProperty("file_operations");
    expect(builtinTools).toHaveProperty("notify_user");
    expect(builtinTools).toHaveProperty("host_info");
  });
});
