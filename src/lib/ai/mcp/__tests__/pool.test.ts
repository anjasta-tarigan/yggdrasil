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
});
