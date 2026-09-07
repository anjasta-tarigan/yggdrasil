// src/lib/ai/tools/__tests__/file-capabilities.test.ts
import { describe, it, expect } from "vitest";
import { probeCliCapabilities } from "../file-capabilities";

describe("Host CLI Capabilities Probing", () => {
  it("probes and returns boolean flags for tools", async () => {
    const caps = await probeCliCapabilities(true);
    expect(typeof caps.hasEza).toBe("boolean");
    expect(typeof caps.hasFd).toBe("boolean");
    expect(typeof caps.hasRipgrep).toBe("boolean");
    expect(typeof caps.hasZoxide).toBe("boolean");
    expect(typeof caps.hasFzf).toBe("boolean");
  });

  it("caches results on subsequent calls unless forceRefresh is true", async () => {
    const caps1 = await probeCliCapabilities(false);
    const caps2 = await probeCliCapabilities(false);
    expect(caps1).toBe(caps2); // Same object reference when cached
  });
});
