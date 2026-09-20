import type { MCPClient } from "@ai-sdk/mcp";
import { connectMcpServer, type McpConnectFn } from "./manager";
import type { McpServerConfig } from "./config";
import { createHash } from "node:crypto";

export interface PoolOptions {
  idleTtlMs?: number;
  /** Maximum number of pooled clients. When exceeded, the least-recently-used idle entry is evicted. Default: 10. */
  maxEntries?: number;
}

interface PoolEntry {
  configHash: string;
  client: MCPClient;
  leaseCount: number;
  idleTimer?: NodeJS.Timeout;
  fingerprints?: Record<string, string>;
  /**
   * Cached raw tool bag from the last successful client.tools() call on
   * THIS pooled client. Cleared on eviction (a new client = new listing).
   * Keyed by nothing else: config changes already force eviction via
   * configHash, so the listing is valid for the entry's lifetime.
   */
  toolBag?: unknown;
  /** Timestamp of last access (lease) — drives LRU eviction. */
  lastAccessAt: number;
}

export class McpClientPool {
  private entries = new Map<string, PoolEntry>();
  private inFlight = new Map<string, Promise<PoolEntry>>();
  private readonly idleTtlMs: number;
  readonly maxEntries: number;

  constructor(options?: PoolOptions) {
    this.idleTtlMs = options?.idleTtlMs ?? 300_000; // 5 minutes default
    this.maxEntries = options?.maxEntries ?? 10;
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
      let connectPromise = this.inFlight.get(config.id);
      if (!connectPromise) {
        // Enforce the max-entries cap before creating a new entry.
        // Evict least-recently-used idle entries (skip leased ones).
        if (this.entries.size >= this.maxEntries) {
          await this.evictLRU();
        }
        connectPromise = (async () => {
          try {
            const client = await connect(config);
            const newEntry: PoolEntry = {
              configHash,
              client,
              leaseCount: 0,
              lastAccessAt: Date.now(),
            };
            this.entries.set(config.id, newEntry);
            return newEntry;
          } finally {
            this.inFlight.delete(config.id);
          }
        })();
        this.inFlight.set(config.id, connectPromise);
      }
      entry = await connectPromise;
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }

    entry.lastAccessAt = Date.now();
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

  /** Tool listing cached on the pooled entry, or undefined when not yet fetched. */
  getCachedToolBag<T>(serverId: string): T | undefined {
    return this.entries.get(serverId)?.toolBag as T | undefined;
  }

  /** Cache a tool listing on the pooled entry (best-effort; no-op when absent). */
  setCachedToolBag(serverId: string, toolBag: unknown): void {
    const entry = this.entries.get(serverId);
    if (entry) {
      entry.toolBag = toolBag;
    }
  }

  /**
   * Evict the least-recently-used idle entry to make room for a new one.
   * Entries with active leases (leaseCount > 0) are never evicted — they
   * are in active use by a caller.
   */
  private async evictLRU(): Promise<void> {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, entry] of this.entries) {
      if (entry.leaseCount > 0) continue;
      if (entry.lastAccessAt < oldestAt) {
        oldestAt = entry.lastAccessAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      await this.evict(oldestId);
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
    } catch (error) {
      console.warn(`[mcp-pool] Error closing client for server "${serverId}":`, error);
    }
  }

  async clear(): Promise<void> {
    const serverIds = Array.from(this.entries.keys());
    await Promise.allSettled(serverIds.map((id) => this.evict(id)));
  }
}

export const mcpClientPool = new McpClientPool();
