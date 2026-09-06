import type { MCPClient } from "@ai-sdk/mcp";
import { connectMcpServer, type McpConnectFn } from "./manager";
import type { McpServerConfig } from "./config";
import { createHash } from "node:crypto";

export interface PoolOptions {
  idleTtlMs?: number;
}

interface PoolEntry {
  configHash: string;
  client: MCPClient;
  leaseCount: number;
  idleTimer?: NodeJS.Timeout;
  sessionId?: string;
  fingerprints?: Record<string, string>;
}

export class McpClientPool {
  private entries = new Map<string, PoolEntry>();
  private readonly idleTtlMs: number;

  constructor(options?: PoolOptions) {
    this.idleTtlMs = options?.idleTtlMs ?? 300_000; // 5 minutes default
  }

  private hashConfig(config: McpServerConfig): string {
    const serialized = JSON.stringify({
      id: config.id,
      transport: config.transport,
      url: config.url,
      headers: config.headers,
      command: config.command,
      args: config.args,
      env: config.env,
    });
    return createHash("sha256").update(serialized).digest("hex");
  }

  async leaseClient(
    config: McpServerConfig,
    connect: McpConnectFn = connectMcpServer
  ): Promise<{ client: MCPClient; release: () => Promise<void> }> {
    const configHash = this.hashConfig(config);
    let entry = this.entries.get(config.id);

    // If config changed while connected, evict old client first
    if (entry && entry.configHash !== configHash) {
      await this.evict(config.id);
      entry = undefined;
    }

    if (!entry) {
      const client = await connect(config);
      entry = {
        configHash,
        client,
        leaseCount: 0,
      };
      this.entries.set(config.id, entry);
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }

    entry.leaseCount++;

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      const current = this.entries.get(config.id);
      if (!current || current !== entry) return;

      current.leaseCount = Math.max(0, current.leaseCount - 1);
      if (current.leaseCount === 0) {
        current.idleTimer = setTimeout(() => {
          void this.evict(config.id);
        }, this.idleTtlMs);
        if (typeof current.idleTimer.unref === "function") {
          current.idleTimer.unref();
        }
      }
    };

    return { client: entry.client, release };
  }

  getCachedFingerprints(serverId: string): Record<string, string> | undefined {
    return this.entries.get(serverId)?.fingerprints;
  }

  setCachedFingerprints(serverId: string, fingerprints: Record<string, string>): void {
    const entry = this.entries.get(serverId);
    if (entry) {
      entry.fingerprints = fingerprints;
    }
  }

  async evict(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    this.entries.delete(serverId);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    try {
      await entry.client.close();
    } catch {
      // ignore errors on close
    }
  }

  async clear(): Promise<void> {
    const serverIds = Array.from(this.entries.keys());
    await Promise.allSettled(serverIds.map((id) => this.evict(id)));
  }
}

export const mcpClientPool = new McpClientPool();
