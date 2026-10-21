# Tool-name collisions between built-ins and MCP

## Findings

An AI SDK `tools` value is a JavaScript object keyed by the model-visible tool name. A key can contain only one implementation: repeated assignments/spreads overwrite the earlier value. The installed AI SDK 7.0.97 enumerates this object with `Object.entries()` and resolves calls with `tools[toolCall.toolName]` (`node_modules/ai/dist/index.js`). Consequently, the model cannot be offered two separate implementations both named exactly `web_fetch` in one request.

MCP scopes tool-name uniqueness to one server. The current protocol guidance says tools from multiple servers may collide and clients or proxies should disambiguate names, for example by prefixing with a server identifier. It also warns against using the server-reported name as a unique identifier. The MCP specification is the source of truth for collisions between servers; the host must route each exposed name back to the owning server.

The AI SDK MCP cookbook explicitly warns that spreading tool sets into one object lets later sets override earlier tools with the same name. The installed `@ai-sdk/mcp` 2.0.37 adapter likewise builds the returned tool bag by assigning `tools[name]`, so a name collision inside an aggregated bag overwrites an earlier entry.

## What “same name” can mean in Yggdrasil

Yggdrasil can preserve an MCP server's internal MCP name `web_fetch`, while exposing one canonical model-facing name `web_fetch`. It must select or dispatch to one implementation behind that key. To expose several servers' `web_fetch` tools concurrently, each needs a unique model-facing alias (Yggdrasil currently uses `<server-slug>__web_fetch`).

Recommended behavior: keep `web_search` and `web_fetch` as the stable built-in public names; make an MCP capability selected as primary the implementation behind that canonical name, with a clearly defined failure fallback to the built-in. Keep other MCP implementations under server-prefixed names only when the user explicitly opts into them. This avoids asking the model to arbitrate near-identical tools and keeps call history/UI names stable.

## Current code discrepancy

`primaryCapabilities` is persisted and shown by the MCP UI, but `collectMcpTools()` does not read it. `protectedToolReason()` exempts every MCP `web_search` and `web_fetch` tool, so all such duplicates are currently exposed under prefixed names regardless of the primary setting. The primary toggle therefore records intent without changing model-visible routing.

## References

- AI SDK Core, Tools and Tool Calling: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- AI SDK Core, MCP Tools: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools
- AI SDK MCP cookbook (explicit warning that spreading same-name tool sets overwrites earlier entries): https://ai-sdk.dev/cookbook/node/mcp-tools
- MCP specification, Server Tools (name scope and client disambiguation): https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- Installed source inspected: `ai@7.0.97` (`normalizeTools`/`Object.entries` and tool lookup in `node_modules/ai/dist/index.js`); `@ai-sdk/mcp@2.0.37` (tool bag assignment in `node_modules/@ai-sdk/mcp/dist/index.js`).
