# MCP Subsystem Optimization, Intelligent Tool Routing & Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize MCP client lifecycle and eliminate multi-second turn latency with connection pooling, implement non-blocking tool coexistence and "Set as Primary" in-turn fallback, add an MCP Marketplace with offline presets and secrets protection, and add real-time search to the Plugin Marketplace.

**Architecture:** Introduce `McpClientPool` for in-memory client and stdio process reuse with a 5-minute idle TTL and Streamable HTTP session resumption. Refactor tool mediation in `manager.ts` so capability tools (`web_search`, `web_fetch`) are never withheld, and expose them as `<slug>__<tool>` with `<specialized_tools>` prompt directives and in-turn fallback. Add an MCP marketplace catalog with pinned stdio presets, secrets SSoT via secure env storage, and real-time filtering for plugin and MCP catalogs.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, AI SDK v7 (`ai@7.0.77`, `@ai-sdk/mcp@2.0.37`), Phosphor Icons, Tailwind CSS v4, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-09-06-mcp-optimization-marketplace-design.md`

## Global Constraints
- Single sequential Vitest runs only (`pnpm test` / `vitest run --maxWorkers=1`), zero concurrent test workers.
- Zero secrets leakage: MCP API keys/tokens are stored in `data/providers.secrets.env` (chmod 600) via reference or masked views; never exposed plaintext to client JSON.
- Never override or withhold core platform tools (`ask_user_question`, `reminder_schedule`, `create_artifact`, `update_artifact`, `read_artifact`, `remember`, `recall_memory`, `forget_memory`, `task_create`, `task_update`, `bash`, `read_file`, `write_file`).
- Version pinning: All MCP presets must specify exact package versions (e.g. `@0.6.2`).
- SSRF defense: All outbound directory fetches must route through `secureFetch()` with `redirect: 'error'` on remote MCP transports.

---

### Task 1: In-Memory MCP Client Pool (`McpClientPool`)

**Files:**
- Create: `src/lib/ai/mcp/pool.ts`
- Test: `src/lib/ai/mcp/__tests__/pool.test.ts`

**Interfaces:**
- Produces:
  - `class McpClientPool`
  - `mcpClientPool: McpClientPool` (singleton)
  - `mcpClientPool.leaseClient(config: McpServerConfig, connect?: McpConnectFn): Promise<{ client: MCPClient; release: () => Promise<void> }>`
  - `mcpClientPool.evict(serverId: string): Promise<void>`
  - `mcpClientPool.clear(): Promise<void>`

- [ ] **Step 1: Write failing tests for client leasing, idle TTL, and eviction**

Create `src/lib/ai/mcp/__tests__/pool.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/ai/mcp/__tests__/pool.test.ts`
Expected: FAIL with "Cannot find module '../pool'"

- [ ] **Step 3: Implement McpClientPool in `src/lib/ai/mcp/pool.ts`**

Write `src/lib/ai/mcp/pool.ts`:
```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/ai/mcp/__tests__/pool.test.ts`
Expected: PASS (all 3 tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/mcp/pool.ts src/lib/ai/mcp/__tests__/pool.test.ts
git commit -m "feat(mcp): add McpClientPool with idle keep-alive and lease management"
```

---

### Task 2: Integrate Pooling & AI SDK v7 Transient Retries in `manager.ts`

**Files:**
- Modify: `src/lib/ai/mcp/manager.ts:280-315, 335-375, 436-625`
- Test: `src/lib/ai/mcp/__tests__/manager.test.ts`

**Interfaces:**
- Modifies `connectMcpServer(config, options)` to include `maxRetries: 2`.
- Modifies `collectMcpTools(options)` to use `mcpClientPool.leaseClient(config)` and cache fingerprints in pool.
- Modifies `collectMcpTools().close` to release leased clients back to the pool.

- [ ] **Step 1: Write test checking `collectMcpTools` pool lease reuse & fingerprint caching**

Update `src/lib/ai/mcp/__tests__/manager.test.ts` with a test verifying that calling `collectMcpTools()` twice reuses the pooled connection rather than reconnecting.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/ai/mcp/__tests__/manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `connectMcpServer` and `collectMcpTools` to use pool & `maxRetries: 2`**

In `src/lib/ai/mcp/manager.ts`:
1. Add `maxRetries: 2` to `createMCPClient` in `connectMcpServer`.
2. In `collectMcpTools`:
   - Replace direct `connect(config)` with `mcpClientPool.leaseClient(config, connect)`.
   - Check `mcpClientPool.getCachedFingerprints(config.id)` before running `fingerprintMcpTools()`.
   - Store computed fingerprints via `mcpClientPool.setCachedFingerprints(config.id, fingerprints)`.
   - In the returned `close()`, invoke all `lease.release()` functions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/ai/mcp/__tests__/manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/mcp/manager.ts src/lib/ai/mcp/__tests__/manager.test.ts
git commit -m "feat(mcp): integrate connection pool and transient retries into manager"
```

---

### Task 3: Capability Tool Coexistence & "Set as Primary" In-Turn Fallback (Approach C)

**Files:**
- Modify: `src/lib/ai/mcp/config.ts:17-46` (add `primaryCapabilities` to `McpServerConfig` schema & sanitization)
- Modify: `src/lib/ai/mcp/manager.ts:58-111, 480-530` (allow `web_search`/`web_fetch` coexistence without withholding)
- Modify: `src/lib/ai/prompt.ts:180-208` (inject `<specialized_tools>` in Layer 3 tool protocols)
- Modify: `src/app/api/chat/route.ts:220-275` (maintain built-in tool in toolset for in-turn fallback)
- Test: `src/lib/ai/mcp/__tests__/config.test.ts`
- Test: `src/lib/ai/mcp/__tests__/manager.test.ts`

**Interfaces:**
- `McpServerConfig.primaryCapabilities?: Array<"web_search" | "web_fetch">`
- `protectedToolReason`: Platform tools are protected (`sandbox`, `delegation`, `task`, `memory`, `artifact`, `core`), but `web_search` and `web_fetch` are explicitly designated capability tools that are exposed under `slug__tool` without withholding.

- [ ] **Step 1: Write failing tests for config validation and capability tool exemption**

In `src/lib/ai/mcp/__tests__/config.test.ts`, test that `primaryCapabilities: ["web_search"]` is properly sanitized and preserved.
In `src/lib/ai/mcp/__tests__/manager.test.ts`, test that a server tool named `web_search` is NOT withheld, but exposed as `slug__web_search`, while `task_create` remains withheld.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test src/lib/ai/mcp/__tests__/config.test.ts src/lib/ai/mcp/__tests__/manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `config.ts`, `manager.ts`, and `prompt.ts`**

1. In `src/lib/ai/mcp/config.ts`:
   - Add `primaryCapabilities?: Array<"web_search" | "web_fetch">` to `McpServerConfig`.
   - Update `sanitizeMcpServerConfig` to validate and copy `primaryCapabilities`.
2. In `src/lib/ai/mcp/manager.ts`:
   - Define `CAPABILITY_TOOL_NAMES = ["web_search", "web_fetch"] as const`.
   - In `protectedToolReason`, if `CAPABILITY_TOOL_NAMES.includes(name)`, return `undefined` (do not withhold; permit coexistence under `slug__name`).
3. In `src/lib/ai/prompt.ts`:
   - Extend `buildToolProtocolsBlock(activeTools)` to inspect active MCP tools and format the `<specialized_tools>` prompt directive inside Layer 3.
4. In `src/app/api/chat/route.ts`:
   - When a primary MCP capability is configured, both the MCP tool and the built-in tool remain in `tools`. The prompt directs the model to call the primary MCP tool first, with instructions to fall back to the built-in tool within the same turn if it fails.
   - Wrap MCP tool execution errors with clear fallback hints.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test src/lib/ai/mcp/__tests__/config.test.ts src/lib/ai/mcp/__tests__/manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/mcp/config.ts src/lib/ai/mcp/manager.ts src/lib/ai/prompt.ts src/app/api/chat/route.ts src/lib/ai/mcp/__tests__/config.test.ts src/lib/ai/mcp/__tests__/manager.test.ts
git commit -m "feat(mcp): implement capability tool coexistence and primary in-turn fallback"
```

---

### Task 4: MCP Secrets SSoT & Preset Catalog

**Files:**
- Create: `src/lib/ai/mcp/secrets.ts`
- Create: `src/lib/ai/mcp/marketplace-presets.ts`
- Modify: `src/app/api/mcp/route.ts` (mask secrets in client JSON response)
- Test: `src/lib/ai/mcp/__tests__/marketplace-presets.test.ts`

**Interfaces:**
- Produces:
  - `writeMcpSecret(key: string, value: string): Promise<void>`
  - `resolveMcpSecret(key: string): Promise<string | undefined>`
  - `MCP_PRESETS: McpPreset[]` (with pinned package versions `@0.6.2`)
  - `maskMcpServerConfig(config: McpServerConfig): McpServerConfig`

- [ ] **Step 1: Write test for secrets storage & preset definitions**

Create `src/lib/ai/mcp/__tests__/marketplace-presets.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { MCP_PRESETS } from "../marketplace-presets";
import { maskMcpServerConfig } from "../secrets";
import type { McpServerConfig } from "../config";

describe("MCP Marketplace Presets & Secrets", () => {
  it("pins all stdio preset versions", () => {
    for (const preset of MCP_PRESETS) {
      if (preset.transport === "stdio" && preset.command) {
        expect(preset.command).toMatch(/@[0-9]+\.[0-9]+\.[0-9]+/);
      }
    }
  });

  it("masks sensitive environment variables in client view", () => {
    const config: McpServerConfig = {
      id: "srv-github",
      name: "GitHub",
      transport: "stdio",
      enabled: true,
      command: "npx -y @modelcontextprotocol/server-github@0.6.2",
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret123456789",
        DEBUG: "true",
      },
    };

    const masked = maskMcpServerConfig(config);
    expect(masked.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("••••••••");
    expect(masked.env?.DEBUG).toBe("true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/ai/mcp/__tests__/marketplace-presets.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `secrets.ts` and `marketplace-presets.ts`**

1. In `src/lib/ai/mcp/secrets.ts`:
   - Reuse `providers.secrets.env` (or dedicated `mcp.secrets.env`) using `parseSecretsEnv` / `serializeSecretsEnv` from `src/lib/ai/provider-config/secrets.ts`.
   - Implement `maskMcpServerConfig`: identify keys matching `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `URL` containing credentials, and mask values for client views.
2. In `src/lib/ai/mcp/marketplace-presets.ts`:
   - Define presets: SQLite, PostgreSQL, GitHub, Git, Puppeteer, Filesystem, Brave Search, Fetch, Memory with pinned `@0.6.2` versions and required variable definitions.
3. In `src/app/api/mcp/route.ts`:
   - Mask server configs with `maskMcpServerConfig` before returning JSON to the browser.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/ai/mcp/__tests__/marketplace-presets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/mcp/secrets.ts src/lib/ai/mcp/marketplace-presets.ts src/app/api/mcp/route.ts src/lib/ai/mcp/__tests__/marketplace-presets.test.ts
git commit -m "feat(mcp): implement secrets SSoT protection and pinned marketplace presets"
```

---

### Task 5: MCP Marketplace API & Verification Gateway

**Files:**
- Create: `src/app/api/mcp/marketplace/route.ts`
- Test: `src/app/api/__tests__/mcp-marketplace-api.test.ts`

**Interfaces:**
- `GET /api/mcp/marketplace?q=...&category=...`:
  - Returns presets filtered by category/query.
  - Queries external community registry with `secureFetch` (SSRF protected) and returns unverified community items marked with `isCommunity: true`.

- [ ] **Step 1: Write test for marketplace API endpoint**

Create `src/app/api/__tests__/mcp-marketplace-api.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { GET } from "../mcp/marketplace/route";
import { NextRequest } from "next/server";

describe("GET /api/mcp/marketplace", () => {
  it("returns curated presets when no query is provided", async () => {
    const req = new NextRequest("http://localhost/api/mcp/marketplace");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.presets)).toBe(true);
    expect(data.presets.length).toBeGreaterThan(0);
  });

  it("filters presets by category", async () => {
    const req = new NextRequest("http://localhost/api/mcp/marketplace?category=databases");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    for (const item of data.presets) {
      expect(item.category).toBe("databases");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/app/api/__tests__/mcp-marketplace-api.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/app/api/mcp/marketplace/route.ts`**

Implement endpoint returning categorized presets and handling community search through `secureFetch()` with safe error fallbacks.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/app/api/__tests__/mcp-marketplace-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/mcp/marketplace/route.ts src/app/api/__tests__/mcp-marketplace-api.test.ts
git commit -m "feat(mcp): add marketplace API route with SSRF protection and preset filtering"
```

---

### Task 6: MCP View Marketplace Tab & Guided Install Modal

**Files:**
- Modify: `src/components/mcp-view.tsx`
- Test: `src/components/__tests__/mcp-view.test.tsx`

**Interfaces:**
- Two-tab layout in `McpView`: `Configured Servers` and `Marketplace`.
- Guided install dialog prompting for missing preset environment variables or arguments.
- "Set as primary search/fetch" toggle on server cards that expose capability tools.

- [ ] **Step 1: Write test for MCP tabs and install modal**

Create `src/components/__tests__/mcp-view.test.tsx`:
Verify tabs render, clicking "Marketplace" displays presets, and clicking "Install" on a preset requiring variables opens the configuration modal.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/__tests__/mcp-view.test.tsx`
Expected: FAIL

- [ ] **Step 3: Update `src/components/mcp-view.tsx`**

1. Introduce `<Tabs defaultValue="configured">`:
   - `Tab 1: Configured Servers`: Existing list, with added "Set as primary search/fetch" switch for capability tools.
   - `Tab 2: Marketplace`: Search input, category filter buttons, and preset cards with "Install" CTA.
2. Add `<McpInstallModal>` for configuring required environment variables / arguments with masked input values before persisting.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/__tests__/mcp-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/mcp-view.tsx src/components/__tests__/mcp-view.test.tsx
git commit -m "feat(mcp): add marketplace tab and guided install modal to McpView"
```

---

### Task 7: Real-Time Search on Plugin Marketplace Tab

**Files:**
- Modify: `src/components/plugins/plugin-marketplaces-tab.tsx`
- Test: `src/components/__tests__/plugins-view.test.tsx`

**Interfaces:**
- Real-time substring search input matching `entry.name`, `entry.displayName`, `entry.description`, `entry.category`.
- Category filter pills dynamically populated from active catalog entries.
- Clear search button and responsive empty state.

- [ ] **Step 1: Write test for plugin search filtering**

In `src/components/__tests__/plugins-view.test.tsx`, add a test asserting that typing a search term in the marketplace tab filters the displayed plugin list and shows an empty state when no results match.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/components/__tests__/plugins-view.test.tsx`
Expected: FAIL

- [ ] **Step 3: Update `PluginMarketplacesTab`**

In `src/components/plugins/plugin-marketplaces-tab.tsx`:
1. Add `searchQuery` and `selectedCategory` state.
2. Render search input with a clear (`X`) button and category filter selector.
3. Compute `filteredEntries` using case-insensitive matching across `name`, `displayName`, `description`, and `category`.
4. Render an informative empty state when `filteredEntries.length === 0`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/components/__tests__/plugins-view.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/plugins/plugin-marketplaces-tab.tsx src/components/__tests__/plugins-view.test.tsx
git commit -m "feat(plugins): add real-time search and category filtering to plugin marketplace tab"
```

---

### Task 8: Full Verification & Integration Testing

**Files:**
- Regression audit across all touched files.

- [ ] **Step 1: Run type checking**

Run: `pnpm tsc --noEmit`
Expected: PASS with 0 type errors.

- [ ] **Step 2: Run ESLint**

Run: `pnpm lint`
Expected: PASS with 0 lint errors.

- [ ] **Step 3: Run complete test suite sequentially**

Run: `pnpm test`
Expected: PASS across all test files with 0 failures and 0 memory leaks.

- [ ] **Step 4: Final commit & status check**

```bash
git status
```
Expected: Clean working tree.
