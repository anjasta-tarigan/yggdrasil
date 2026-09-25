import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "../route";
import { sqlite } from "@/db";
import {
  saveRegistry,
  setProviderConfigPathsForTest,
} from "@/lib/ai/provider-config/store";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";

vi.mock("@/lib/bootstrap", () => ({
  bootstrapAutonomousCognitiveSystem: vi.fn(),
}));

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

describe("Health API internal system health", () => {
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

  it("reports internal system health, server time, and subsystems on ok status", async () => {
    await saveRegistry(seedDoc("http://localhost:20128/v1"));

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      modelId: string | null;
      uptimeSeconds: number;
      memoryHeapMb: number;
      subsystems: {
        database: { status: string; wal?: boolean };
        queue: { status: string; running: boolean };
        daemon: { status: string; running: boolean };
      };
      serverTime: { now: string; timezone: string };
    };

    expect(json.status).toBe("ok");
    expect(json.modelId).toBe("test-model");
    expect(typeof json.uptimeSeconds).toBe("number");
    expect(typeof json.memoryHeapMb).toBe("number");
    expect(json.subsystems.database.status).toBe("ok");
    expect(typeof json.subsystems.queue.running).toBe("boolean");
    expect(typeof json.subsystems.daemon.running).toBe("boolean");

    // serverTime.now parses as a fresh timestamp (within 5s of now)
    const t = new Date(json.serverTime.now).getTime();
    expect(Number.isFinite(t)).toBe(true);
    expect(Math.abs(t - Date.now())).toBeLessThan(5_000);
    // timezone is a real IANA zone. CI runners resolve to the region-less
    // "UTC", which is a valid IANA identifier, so accept it alongside
    // Area/Location names.
    expect(json.serverTime.timezone).toMatch(/^(UTC|[A-Za-z]+\/[A-Za-z_+-]+)$/);
  });

  it("remains operational even when registry has no AI provider configured", async () => {
    // Empty temp dir: no providers.json configured
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      modelId: string | null;
      subsystems: { database: { status: string } };
      serverTime: { now: string; timezone: string };
    };

    // Internal system health should still be operational regardless of AI provider config
    expect(json.status).toBe("ok");
    expect(json.modelId).toBeNull();
    expect(json.subsystems.database.status).toBe("ok");
    expect(typeof json.serverTime.now).toBe("string");
    expect(typeof json.serverTime.timezone).toBe("string");
  });

  it("reports down when the internal database fails", async () => {
    vi.spyOn(sqlite, "prepare").mockImplementation(() => {
      throw new Error("disk I/O error");
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      error?: string;
      subsystems: { database: { status: string; error?: string } };
      serverTime: { now: string };
    };

    expect(json.status).toBe("down");
    expect(json.subsystems.database.status).toBe("down");
    expect(json.error).toContain("disk I/O error");
    expect(typeof json.serverTime.now).toBe("string");
  });
});
