# MCP Subsystem Optimization, Intelligent Tool Routing & Marketplace Design

## 1. Executive Summary
This specification defines architectural upgrades to Yggdrasil's Model Context Protocol (MCP) integration, intelligent tool mediation between MCP and built-in capabilities, an in-shell MCP Marketplace for 1-click server installations, and real-time search for the Claude Code Plugin Marketplace.

The enhancements solve three primary challenges:
1. **Chat Turn Latency:** Eliminate 1.5s–4.0s per-turn connection and child-process spawning overhead through an in-memory connection pool with idle keep-alive and AI SDK v7 session resumption.
2. **Capability Conflict & Coexistence (Approach C):** Decouple platform-critical tools (which must remain protected) from capability tools (such as web search and fetch), allowing external MCP servers to cleanly coexist under namespaced identifiers or be designated as the primary provider with dynamic prompt routing.
3. **Discoverability & Installation:** Introduce a dedicated MCP Marketplace featuring curated verified presets and community directory search with guided configuration modals, alongside real-time search filtering in the Plugin Marketplace.

---

## 2. Architecture & Subsystems

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Chat Turn Pipeline                              │
│                                                                        │
│   src/app/api/chat/route.ts                                            │
│        │                                                               │
│        ▼                                                               │
│   McpClientPool (src/lib/ai/mcp/pool.ts) ─── In-Memory Reuse (0ms)     │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │ • Leased clients with 5-min idle keep-alive TTL              │     │
│   │ • Child process stdio reuse (Node/npx)                       │     │
│   │ • Streamable HTTP session resumption (initialSessionId)      │     │
│   │ • Cached tool digests & drift fingerprints                   │     │
│   └──────────────────────────────────────────────────────────────┘     │
│        │                                                               │
│        ▼                                                               │
│   Tool Mediation Engine (src/lib/ai/mcp/manager.ts)                    │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │ • Platform-critical tools (task, memory, artifact, core):    │     │
│   │   Always protected, conflicting MCP tools withheld.          │     │
│   │ • Capability tools (web_search, web_fetch):                  │     │
│   │   Exposed as <slug>__<tool> with prompt routing.             │     │
│   │ • "Set as Primary" preference: Model prioritized to call     │     │
│   │   MCP tool; built-in remains active as secondary fallback    │     │
│   │   within the same multi-step turn if the MCP call fails.     │     │
│   └──────────────────────────────────────────────────────────────┘     │
│        │                                                               │
│        ▼                                                               │
│   Prompt Routing (src/lib/ai/prompt.ts)                                │
│   Injects <specialized_tools> protocols for active MCP capabilities    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Specifications

### 3.1 Phase 1: MCP Subsystem Optimization & Runtime Pool

#### 3.1.1 In-Memory Connection Pool (`McpClientPool`)
- **Location:** `src/lib/ai/mcp/pool.ts`
- **Key Characteristics:**
  - Singleton registry holding active `MCPClient` instances and their metadata.
  - Keyed by `cacheKey`: `${server.id}:${sha256(transportConfig)}`.
  - Lease mechanism: `pool.leaseClient(config)` returns an active client. If already connected and responsive, returns immediately without re-handshaking.
  - Concurrent lease safety: The client lease counter is atomically incremented on lease and decremented on release. The underlying `@ai-sdk/mcp` JSON-RPC transport uniquely identifies request/response pairs via integer IDs, allowing concurrent execution across independent chat requests safely.
  - Multi-step turn lease scoping: A lease is acquired once at the beginning of a chat request in `src/app/api/chat/route.ts` and held continuously across the entire multi-step tool execution loop (up to 30 steps). The lease is only released when the stream settles in `onEnd` or `onError`, preventing idle eviction mid-turn.
  - Idle keep-alive TTL: Defaults to 5 minutes (`300_000ms`). Each lease resets the eviction timer. When the timer expires without active leases, `client.close()` is called and stdio child processes exit.
  - Configuration change eviction: When a server is updated, disabled, or removed via settings, `pool.evict(serverId)` forcibly closes and purges the client from memory.
  - Process exit hook: Clean up all pooled clients and child processes on `process.on('beforeExit')`, `SIGINT`, and `SIGTERM`.

#### 3.1.2 AI SDK v7 Streamable HTTP Session Resumption
- When creating an HTTP transport client, store `sessionId` and `initializeResult` in the pool entry upon successful initialization.
- If reconnecting a dropped HTTP client, supply `initialSessionId` and `initialInitializeResult` to avoid redundant protocol handshakes.
- Configure `maxRetries: 2` on `createMCPClient` to smoothly handle transient connection drops and HTTP 503/gateway timeouts.

#### 3.1.3 Drift & Fingerprint In-Memory Caching
- Cache the computed tool fingerprints (`Record<string, string>`) in the pool entry alongside the client.
- Only re-fingerprint when:
  1. A new client is instantiated.
  2. The server fires a `notifications/tools/list_changed` JSON-RPC notification.
  3. The user explicitly triggers "Test connection" or "Review & approve" in the UI.

#### 3.1.4 Guaranteed Cleanup in Chat Pipeline
- Refactor `src/app/api/chat/route.ts` so that MCP lease acquisition and subsequent stream generation are wrapped in a robust `try ... finally` block:
  - If any error occurs prior to stream registration (such as context budgeting or system prompt generation), leases are released immediately.
  - On stream settlement (`onEnd` and `onError`), the client leases are returned to the pool.

---

### 3.2 Phase 1 (Continued): Intelligent Built-in Tool Coexistence (Approach C)

#### 3.2.1 Tool Classification & Precedence Rules
- **Reserved Core Built-in Tools (Protected):**
  - `ask_user_question`, `reminder_schedule`, `create_artifact`, `update_artifact`, `read_artifact`, `remember`, `recall_memory`, `forget_memory`, `task_create`, `task_update`, `bash`, `read_file`, `write_file`.
  - *Behavior:* If an MCP server exposes a tool with any of these names, it is withheld with an explicit warning recorded in `McpServerRuntimeStatus.withheld`.
- **Capability Tools (Coexistence & Primary Routing):**
  - `web_search`, `web_fetch`.
  - *Behavior:* Never withheld by default. Exposed to the model as `<slug>__<tool_name>` (e.g. `brave__search` or `brave__web_search`).
- **Slug Derivation & Collision Invariants:**
  - Slugs are strictly sanitized to `^[a-z0-9-]+$` with a max length of 40 chars.
  - If two configured servers produce identical slugs (e.g. two servers named "Brave"), the manager appends a numeric suffix (`brave-2__...`) to guarantee uniqueness across all provider tool-call schemas.

#### 3.2.2 "Set as Primary" Preference & Genuine In-Turn Fallback
- Update `McpServerConfig` in `src/lib/ai/mcp/config.ts`:
  ```typescript
  export type McpServerConfig = {
    // ... existing fields
    primaryCapabilities?: Array<"web_search" | "web_fetch">;
  };
  ```
- **Genuine In-Turn Automatic Fallback:**
  - When an MCP server is designated as primary for `web_search` or `web_fetch`, the built-in tool is **NOT** disabled or removed from the model's toolset.
  - Instead, both tools remain present in the active toolset. The system prompt directive explicitly orders the model to invoke the primary MCP tool first.
  - If the primary MCP tool invocation fails (returns an error result, times out, or throws), the tool result includes: `[error: primary MCP search failed. Fallback to built-in 'web_search' is available]`.
  - Because `web_search` remains available in the same multi-step step loop (up to 30 steps), the model immediately falls back to calling the built-in `web_search` within the exact same chat turn, achieving 100% automated fallback resilience without user intervention.

#### 3.2.3 Prompt Guidance Engine & Layer Integration
- In `src/lib/ai/prompt.ts`, `<specialized_tools>` is injected inside `buildToolProtocolsBlock()` (Layer 3: Dynamic Tool Protocols).
- Placement: It sits directly following the standard tool protocol rules and before the static Layer 4 Skills Catalog and Layer 5 Persona directives.
- Cache Stability: Because `<specialized_tools>` derives only from the active configured/enabled server set, it remains deterministic and stable across chat turns within a session, preserving Anthropic prompt-cache hits.
  ```xml
  <specialized_tools>
  The following external MCP tools are active:
  - 'brave__web_search': Primary search provider. Call this first for all real-time web searches. If it fails, call 'web_search'.
  - 'puppeteer__web_fetch': Headless browser page fetch. Use when pages require JavaScript rendering.
  </specialized_tools>
  ```

---

### 3.3 Phase 2: MCP Marketplace

#### 3.3.1 UI Structure (`src/components/mcp-view.tsx`)
Transform `McpView` into a two-tab interface using the project's standard tab patterns:
1. **Tab 1: "Configured Servers"**
   - Active servers list with enable switch, transport badges, tool counts, drift warnings, test connection button, and "Set as primary search/fetch" toggle when capability tools are present.
   - Manual "Add custom server" form.
2. **Tab 2: "Marketplace"**
   - Search bar and category filter pills (All, Databases, Developer Tools, Web & Search, Productivity).
   - Grid/list of available MCP servers displaying:
     - Name, author/source, description, stars/install count, transport type.
     - "Install" button.

#### 3.3.2 Preset Catalog (`src/lib/ai/mcp/marketplace-presets.ts`)
Curated, offline-first server presets with pinned package versions (supply-chain security) and explicit secret metadata:
- **Pinning Invariant:** All stdio package execution MUST pin exact versions (e.g. `npx -y @modelcontextprotocol/server-github@0.6.2`) to prevent unverified patch mutability and ensure reproducible behavior.
- **Databases:**
  - SQLite: `@modelcontextprotocol/server-sqlite@0.6.2` (stdio, requires database path)
  - PostgreSQL: `@modelcontextprotocol/server-postgres@0.6.2` (stdio, requires `POSTGRES_URL`)
- **Dev Tools:**
  - GitHub: `@modelcontextprotocol/server-github@0.6.2` (stdio, requires `GITHUB_PERSONAL_ACCESS_TOKEN`)
  - Git: `@modelcontextprotocol/server-git@0.6.2` (stdio, requires repository path)
  - Puppeteer: `@modelcontextprotocol/server-puppeteer@0.6.2` (stdio, browser automation)
  - Filesystem: `@modelcontextprotocol/server-filesystem@0.6.2` (stdio, requires allowed directory paths)
- **Web & Search:**
  - Brave Search: `@modelcontextprotocol/server-brave-search@0.6.2` (stdio, requires `BRAVE_API_KEY`)
  - Fetch: `@modelcontextprotocol/server-fetch@0.6.2` (stdio, standard web fetching)
  - Memory: `@modelcontextprotocol/server-memory@0.6.2` (stdio, knowledge graph memory)

#### 3.3.3 Guided Install Modal & Strict Secrets SSoT Integration
- **Zero Secrets Leakage (Conforms to Provider-Config SSoT Architecture):**
  - Sensitive environment variables (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`, `BRAVE_API_KEY`, `POSTGRES_URL`) entered in the modal are **NEVER** stored plaintext in SQLite settings (`mcpServers`).
  - Instead, secrets are written directly to the server-side, chmod-600 environment file (`data/providers.secrets.env` or dedicated `data/mcp.secrets.env`) via `writeSecretsEnv`.
  - The stored `McpServerConfig.env` only holds variable name pointers or masked references (`apiKeyEnv: "MCP_SERVER_GITHUB_TOKEN"`).
  - **Sanitized Client Views:** Any API endpoint returning MCP configurations (`GET /api/mcp`, `GET /api/settings`) strictly filters and masks environment values before sending JSON to the browser (`hasSecret: true, masked: "••••••••"`), preventing browser credential leaks.
- **Install Flow:**
  - Modal prompts for arguments and secrets with clear descriptions.
  - Generates a sanitized `McpServerConfig` + writes secrets to the secure env store.
  - Triggers a test connection and returns sanitized feedback to the client.

#### 3.3.4 Community Directory Integration & Verification Gateway
- **Verification Gateway for Community Servers:**
  - Community directory items (from Smithery / open registries) are marked with an unverified warning badge (`Unverified Community Server`).
  - Installing a community server presents an explicit confirmation dialog:
    > *"Security Notice: Community MCP servers execute arbitrary code or communicate with external endpoints not audited by Yggdrasil. Verify the command, package source, and permissions before continuing."*
  - Requires explicit user acknowledgement before the config is saved.
- **SSRF Protection on Directory Proxy:**
  - Any server-side fetching of external directory catalogs (`/api/mcp/marketplace`) MUST route through `secureFetch()` (`src/lib/security/ssrf.ts`) to validate DNS, prevent private/cloud-metadata loopback attacks, enforce the 10s timeout, and restrict max response size (10MB).

---

### 3.4 Phase 3: Plugin Marketplace Search Feature

#### 3.4.1 Component Update (`src/components/plugins/plugin-marketplaces-tab.tsx`)
Add a real-time search and filter bar above the catalog entries list:
- **Instant Search Input:**
  - Case-insensitive substring search matching against `entry.name`, `entry.displayName`, `entry.description`, and `entry.category`.
  - Clear button (`X`) when a query is entered.
- **Category Filter:**
  - Dynamically extracts available categories from the active marketplace catalog.
  - Dropdown or horizontal badges allowing filtering by category.
- **Status Filter:**
  - Filter by `All`, `Installed`, or `Not Installed`.
- **Empty State Feedback:**
  - Shows clear empty state when no plugins match search criteria with a "Clear search" action.

---

## 4. Security & Isolation Invariants

1. **Isolation Invariant (Global Rule 06):** stdio commands execute locally; configurations are strictly validated by `sanitizeMcpServerConfig` (bounded command lengths, sanitization of env keys, no shell injection).
2. **SSRF Protection (Global Rule 04 & AI SDK v7):** Remote HTTP/SSE servers maintain `redirect: 'error'` by default to prevent redirection to internal/private IPs.
3. **Drift & Rug Pull Invariant:** All MCP servers continue to enforce TOFU (trust on first use) definition baselines with SHA-256 fingerprinting. Changed or new tools remain withheld until explicit user approval.
4. **Protected Tool Invariant:** Core internal tools (`ask_user_question`, `task_*`, `memory_*`, `create_artifact`) cannot be overridden by external MCP servers under any circumstance.

---

## 5. Testing Plan

1. **Unit Tests:**
   - `src/lib/ai/mcp/__tests__/pool.test.ts`: Test client reuse, lease counting, idle TTL eviction, configuration update eviction, and process shutdown cleanup.
   - `src/lib/ai/mcp/__tests__/manager.test.ts`: Verify capability coexistence (allowing `web_search`/`web_fetch` as namespaced tools without withholding), "primaryCapabilities" routing, and protected tool defense.
   - `src/lib/ai/mcp/__tests__/marketplace.test.ts`: Test preset generation, variable substitution, and validation.
2. **Component Tests:**
   - `src/components/__tests__/mcp-view.test.tsx`: Test tab switching, preset installation modal, primary capability toggles, and server testing.
   - `src/components/__tests__/plugins-view.test.tsx`: Test plugin search filtering, category filtering, and empty state rendering.
3. **Regression Tests:**
   - Run existing test suites (`pnpm test`) sequentially with worker limits to verify zero regressions across the chat pipeline and settings store.
