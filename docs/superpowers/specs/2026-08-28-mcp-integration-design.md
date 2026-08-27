# MCP (Model Context Protocol) Integration Design

## Overview
Integrates the AI SDK v7 MCP client (`@ai-sdk/mcp`) into Yggdrasil so the assistant can use tools from arbitrary MCP servers. Server configuration lives in the SQLite settings store and is managed from a dedicated in-shell "MCP Servers" page (sidebar System menu); the chat route connects the enabled servers on every request and merges their tools with the built-in chat tools.

## Goals
- Let the user register MCP servers over the three AI SDK transports: Streamable HTTP (`http`, recommended), SSE (`sse`, legacy remote), and `stdio` (local child process).
- Expose server tools to the chat model automatically, prefixed `server-name__tool-name` so tools from different servers and the built-in tools never collide.
- Include server-provided `instructions` from the initialize handshake in the system prompt.
- Detect tool-definition drift ("rug pull") with the v7 `fingerprintTools` / `detectToolDrift` helpers and withhold changed/new tools until the user re-approves a server.
- Surface connection health, tool counts and drift reports on the MCP page, with a manual "Test connection" action.

## Architecture

### Settings store keys
- `mcpServers` — `McpServerConfig[]` registry (id, name, transport, enabled, url/headers for http+sse, command/args/env for stdio).
- `mcpBaselines` — approved tool fingerprints per server id: `{ [serverId]: { fingerprints: Record<toolName, digest>, updatedAt } }`.
- `mcpStatus` — last connection outcome per server id (ok/error, toolCount, serverName, protocolVersion, drift, lastAttemptAt) for the MCP page.

All three are validated on read and write through `sanitizeMcpServerConfig` / `sanitizeMcpServerList` (`src/lib/ai/mcp/config.ts`), a pure module shared by server and client code.

### Server-side manager (`src/lib/ai/mcp/manager.ts`)
- `connectMcpServer(config)` — builds the transport (`{ type: 'http'|'sse', url, headers }` or `Experimental_StdioMCPTransport`) and opens a client with a bounded 15s handshake timeout.
- `collectMcpTools({ db?, connect? })` — per chat request: connects every enabled server in parallel (`Promise.allSettled`), lists tools, applies the drift policy, prefixes tool names with a unique per-server slug, aggregates instructions, and returns `{ tools, instructions, close, statuses }`. Clients are short-lived; `close()` is idempotent and called when the response stream settles.
- `applyDriftPolicy` — trust-on-first-use: the first fingerprint set becomes the approved baseline. On later passes `detectToolDrift` compares against it; changed and newly added tools are removed from the model-visible set and reported as drift. Baselines are never updated automatically.
- `refreshMcpBaseline(serverId)` — reconnects, re-fingerprints and stores the new baseline (the Settings "approve" action).
- `testMcpServerConnection(config)` — connect + `listTools` + close for the UI test action; persists nothing.

### Chat integration (`src/app/api/chat/route.ts`)
`collectMcpTools()` runs before `streamText`. MCP tools are spread after `chatTools` (a name collision can never shadow a built-in). Server instructions are appended to the synthesized system prompt. Clients close in `onEnd`/`onError`/catch paths. Any collection failure degrades gracefully to built-in tools only.

### API surface
- `GET /api/settings` / `PUT /api/settings` — `store.mcpServers` added; PUT payloads shape-validated.
- `GET /api/mcp` — registry snapshot: servers, last statuses, baseline summary. Never opens connections.
- `POST /api/mcp/test` — `{ id }` for a saved server or `{ config }` for an unsaved draft; returns server info, protocol version, instructions and the tool list (502 with the error on failure).
- `POST /api/mcp/approve` — `{ id }`; re-approves the server's current tool definitions.

### MCP page (`src/components/mcp-view.tsx`)
Dedicated in-shell page, opened from the sidebar's System menu ("MCP Servers" entry, above Settings) and rendered in the content area with the same layout contract as SettingsView (sidebar/header/status footer stay in place, "Back to chat" button, centered `max-w-3xl` column). Contents: page header, per-server enable switch, transport badge, target (URL or command line), status badge (active tool count / unreachable / drift detected / disabled), test-connection result panel with the discovered tools, drift banner with a "Review & approve current tools" action, and an add-server form (name, transport, url + headers or command + args + env).

## Security model
- Single-user self-hosted app: configs are user-managed; stdio servers run as local child processes (no shell), so only trusted commands should be added.
- HTTP redirects are rejected by default (v7 `redirect: 'error'`) to prevent SSRF via malicious servers.
- URLs are restricted to http(s); header names must be valid HTTP tokens; env keys must be valid identifiers; all strings length-bounded.
- Drift detection pins the human-approved tool definitions (description, input schema, title). A server that later mutates a definition or adds tools gets those withheld from the model until explicit re-approval.

## Testing
- `src/lib/ai/mcp/__tests__/config.test.ts` — validation matrix for configs, lists, slugs, ids.
- `src/lib/ai/mcp/__tests__/manager.test.ts` — a fake in-memory `MCPTransport` speaking the legacy initialize/tools-list JSON-RPC handshake drives the real `createMCPClient`, `fingerprintTools` and `detectToolDrift`: prefixing, slug collisions, TOFU baselines, drift blocking, re-approval, failure isolation, client lifecycle.
- `src/app/api/__tests__/settings-api.test.ts` — extended for `mcpServers` persistence and rejection cases.

## Out of scope (future work)
- MCP Apps (`ui://` interactive tool UIs via `experimental_MCPAppRenderer`): needs a sandboxed iframe route and message-part rendering.
- OAuth (`authProvider`) for protected remote servers.
- Elicitation request handling (server-initiated user input prompts).
- Resources/prompts/completions surfacing in the UI.
