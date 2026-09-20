import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpClientPool } from "../pool";
import type { McpServerConfig } from "../config";
import type { MCPClient } from "@ai-sdk/mcp";

describe("McpClientPool", () => {
  let pool: McpClientPool;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new McpClientPool({ idleTtlMs: 1000 });
  });

  afterEach(async () => {
    await pool.clear();
    vi.useRealTimers();
  });

  it("reuses connected client for identical server config", async () => {
    let connectCalls = 0;
    const fakeClient = {
      serverInfo: { name: "test-server", version: "1.0.0" },
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;

    const mockConnect = vi.fn().mockImplementation(async () => {
      connectCalls++;
      return fakeClient;
    });

    const config: McpServerConfig = {
      id: "srv-1",
      name: "Test",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    };

    const lease1 = await pool.leaseClient(config, mockConnect);
    expect(connectCalls).toBe(1);

    const lease2 = await pool.leaseClient(config, mockConnect);
    expect(connectCalls).toBe(1); // reused!

    await lease1.release();
    await lease2.release();
  });

  it("closes client after idle TTL when all leases are released", async () => {
    const fakeClient = {
      serverInfo: { name: "test-server", version: "1.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;

    const config: McpServerConfig = {
      id: "srv-2",
      name: "Test",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    };

    const lease = await pool.leaseClient(config, async () => fakeClient);
    await lease.release();

    expect(fakeClient.close).not.toHaveBeenCalled();

    // Advance past idle TTL
    await vi.advanceTimersByTimeAsync(1100);
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  it("evicts and closes client immediately on evict(serverId)", async () => {
    const fakeClient = {
      serverInfo: { name: "test-server", version: "1.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;

    const config: McpServerConfig = {
      id: "srv-3",
      name: "Test",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    };

    const lease = await pool.leaseClient(config, async () => fakeClient);
    await pool.evict("srv-3");

    expect(fakeClient.close).toHaveBeenCalledTimes(1);
    await lease.release(); // safe after eviction
  });

  it("prevents concurrent connection races with in-flight promise sharing", async () => {
    let connectCalls = 0;
    const fakeClient = {
      serverInfo: { name: "test-server", version: "1.0.0" },
      tools: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;

    const mockConnect = vi.fn().mockImplementation(async () => {
      connectCalls++;
      // simulate async connection microtask delay without setTimeout (fakeTimers are active)
      await Promise.resolve();
      await Promise.resolve();
      return fakeClient;
    });

    const config: McpServerConfig = {
      id: "srv-concurrent",
      name: "Concurrent Test",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    };

    const [lease1, lease2] = await Promise.all([
      pool.leaseClient(config, mockConnect),
      pool.leaseClient(config, mockConnect),
    ]);

    expect(connectCalls).toBe(1);
    expect(lease1.client).toBe(fakeClient);
    expect(lease2.client).toBe(fakeClient);

    await lease1.release();
    await lease2.release();
  });

  it("evicts and reconnects when server configuration changes", async () => {
    const fakeClient1 = {
      serverInfo: { name: "test-server-1", version: "1.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;
    const fakeClient2 = {
      serverInfo: { name: "test-server-2", version: "2.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;

    const configV1: McpServerConfig = {
      id: "srv-drift",
      name: "Drift Test",
      transport: "http",
      url: "https://example.com/mcp-v1",
      enabled: true,
    };
    const configV2: McpServerConfig = {
      ...configV1,
      url: "https://example.com/mcp-v2",
    };

    const lease1 = await pool.leaseClient(configV1, async () => fakeClient1);
    expect(lease1.client).toBe(fakeClient1);

    // Lease with changed config
    const lease2 = await pool.leaseClient(configV2, async () => fakeClient2);
    expect(fakeClient1.close).toHaveBeenCalledTimes(1);
    expect(lease2.client).toBe(fakeClient2);

    await lease1.release();
    await lease2.release();
  });

  it("stores and retrieves cached fingerprints", async () => {
    const fakeClient = {
      serverInfo: { name: "test-server", version: "1.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;

    const config: McpServerConfig = {
      id: "srv-fp",
      name: "Fingerprint Test",
      transport: "http",
      url: "https://example.com/mcp",
      enabled: true,
    };

    expect(pool.getCachedFingerprints("srv-fp")).toBeUndefined();

    const lease = await pool.leaseClient(config, async () => fakeClient);
    expect(pool.getCachedFingerprints("srv-fp")).toBeUndefined();

    const fingerprints = { toolA: "hashA", toolB: "hashB" };
    pool.setCachedFingerprints("srv-fp", fingerprints);

    expect(pool.getCachedFingerprints("srv-fp")).toEqual(fingerprints);

    await lease.release();
  });

  it("evicts least-recently-used idle entry when maxEntries is exceeded", async () => {
    const clientA = {
      serverInfo: { name: "server-a", version: "1.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;
    const clientB = {
      serverInfo: { name: "server-b", version: "1.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;
    const clientC = {
      serverInfo: { name: "server-c", version: "1.0.0" },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as MCPClient;

    const pool = new McpClientPool({ idleTtlMs: 1000, maxEntries: 2 });

    const configA: McpServerConfig = {
      id: "srv-a",
      name: "A",
      transport: "http",
      url: "https://a.example.com/mcp",
      enabled: true,
    };
    const configB: McpServerConfig = {
      id: "srv-b",
      name: "B",
      transport: "http",
      url: "https://b.example.com/mcp",
      enabled: true,
    };
    const configC: McpServerConfig = {
      id: "srv-c",
      name: "C",
      transport: "http",
      url: "https://c.example.com/mcp",
      enabled: true,
    };

    // Fill the pool with A and B
    const leaseA = await pool.leaseClient(configA, async () => clientA);
    await vi.advanceTimersByTimeAsync(100);
    const leaseB = await pool.leaseClient(configB, async () => clientB);
    await leaseA.release();
    await leaseB.release();

    // Re-lease A to make it the most recently used, then release
    await vi.advanceTimersByTimeAsync(100);
    const leaseA2 = await pool.leaseClient(configA, async () => clientA);
    await leaseA2.release();

    // Leasing C should trigger LRU eviction of B (older lastAccessAt)
    await vi.advanceTimersByTimeAsync(100);
    const leaseC = await pool.leaseClient(configC, async () => clientC);

    expect(clientB.close).toHaveBeenCalledTimes(1);
    expect(clientA.close).not.toHaveBeenCalled();
    expect(leaseC.client).toBe(clientC);

    await leaseC.release();
    await pool.clear();
  });
});
