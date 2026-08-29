import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "../route";

vi.mock("@/lib/bootstrap", () => ({
  bootstrapAutonomousCognitiveSystem: vi.fn(),
}));

describe("Health API serverTime", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports server time and timezone on every status path (ok)", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://localhost:20128/v1");
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_MODEL_ID", "test-model");

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

  it("includes serverTime when LLM_BASE_URL is not set", async () => {
    vi.stubEnv("LLM_BASE_URL", "");

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      error?: string;
      serverTime: { now: string; timezone: string };
    };
    expect(json.status).toBe("down");
    expect(json.error).toContain("LLM_BASE_URL");
    expect(typeof json.serverTime.now).toBe("string");
    expect(typeof json.serverTime.timezone).toBe("string");
  });

  it("includes serverTime when the gateway is unreachable", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://localhost:1/v1");
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("LLM_MODEL_ID", "test-model");

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
