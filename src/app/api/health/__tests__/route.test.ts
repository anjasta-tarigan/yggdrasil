import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "../route";
import {
  saveRegistry,
  setProviderConfigPathsForTest,
} from "@/lib/ai/provider-config/store";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";

vi.mock("@/lib/bootstrap", () => ({
  bootstrapAutonomousCognitiveSystem: vi.fn(),
}));

/**
 * Seed a registry with a "server" provider the health route can ping.
 * Tests run against a temp data dir — never the developer's real
 * data/providers.json.
 */
function seedDoc(baseUrl: string): RegistryDocument {
  return {
    version: 1,
    providers: [
      {
        id: "server",
        kind: "openai-compatible",
        name: "This server",
        baseUrl,
        models: [
          {
            modelId: "test-model",
            displayName: "Test Model",
            isDefault: true,
            capabilities: {
              contextWindow: null,
              maxOutputTokens: null,
              inputModalities: ["text"],
              outputModalities: ["text"],
              supportsToolCalls: null,
              supportsReasoning: null,
            },
            capabilitySources: {},
          },
        ],
      },
    ],
  };
}

describe("Health API serverTime", () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), "ygg-health-"));
    setProviderConfigPathsForTest(dataDir);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reports server time and timezone on every status path (ok)", async () => {
    await saveRegistry(seedDoc("http://localhost:20128/v1"));

    // Mock a healthy /models response from the gateway.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
        status: 200,
      })
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      serverTime: { now: string; timezone: string };
    };

    expect(json.status).toBe("ok");
    // serverTime.now parses as a fresh timestamp (within 5s of now)
    const t = new Date(json.serverTime.now).getTime();
    expect(Number.isFinite(t)).toBe(true);
    expect(Math.abs(t - Date.now())).toBeLessThan(5_000);
    // timezone is a real IANA zone
    expect(json.serverTime.timezone).toMatch(/^[A-Za-z]+\/[A-Za-z_+-]+$/);
  });

  it("includes serverTime when the registry has no provider", async () => {
    // No providers.json in the temp dir: the route reports "down" with
    // a named error (registry-backed — the LLM_* env reads are gone).
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      error?: string;
      serverTime: { now: string; timezone: string };
    };
    expect(json.status).toBe("down");
    expect(json.error).toBe("No provider configured");
    expect(typeof json.serverTime.now).toBe("string");
    expect(typeof json.serverTime.timezone).toBe("string");
  });

  it("includes serverTime when the gateway is unreachable", async () => {
    await saveRegistry(seedDoc("http://localhost:1/v1"));

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("connection refused")
    );

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      serverTime: { now: string };
    };
    expect(json.status).toBe("down");
    expect(typeof json.serverTime.now).toBe("string");
  });
});
