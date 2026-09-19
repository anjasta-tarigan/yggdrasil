import { NextResponse } from "next/server";
import { splitMCPAppTools, type ListToolsResult } from "@ai-sdk/mcp";
import {
  connectMcpServer,
  getMcpServerConfigs,
} from "@/lib/ai/mcp/manager";

/**
 * Proxy an app-visible tool call from an MCP Apps iframe to the MCP server.
 *
 * POST body:
 *   serverId  — which MCP server to call against (required)
 *   toolName  — the tool name (required)
 *   arguments — tool arguments (optional, defaults to {})
 *
 * Security: the tool is validated against the app-visible set (tools whose
 * `_meta.ui.visibility` includes `"app"`) before being forwarded. Any tool
 * that is model-visible, app-invisible, or unknown is rejected with 403.
 *
 * In production, additional policy / user-approval checks can be layered
 * on top of this validation before forwarding.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    console.debug(`[route] Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { serverId, toolName, arguments: toolArguments } = body as {
    serverId?: unknown;
    toolName?: unknown;
    arguments?: unknown;
  };

  if (typeof serverId !== "string" || !serverId) {
    return NextResponse.json(
      { error: "Missing or invalid 'serverId'" },
      { status: 400 },
    );
  }

  if (typeof toolName !== "string" || !toolName) {
    return NextResponse.json(
      { error: "Missing or invalid 'toolName'" },
      { status: 400 },
    );
  }

  const config = getMcpServerConfigs().find((s) => s.id === serverId);
  if (!config) {
    return NextResponse.json(
      { error: `Unknown MCP server: ${serverId}` },
      { status: 404 },
    );
  }
  if (!config.enabled) {
    return NextResponse.json(
      { error: `MCP server "${config.name}" is disabled` },
      { status: 403 },
    );
  }

  let client;
  try {
    client = await connectMcpServer(config);

    // List tools and split into model-visible vs app-visible.
    const definitions = await client.listTools();
    const { appVisible } = splitMCPAppTools(
      definitions as ListToolsResult,
    );

    // Validate: only app-visible tools may be called from the iframe.
    const isAllowed = appVisible.tools.some(
      (tool) => tool.name === toolName,
    );

    if (!isAllowed) {
      return NextResponse.json(
        {
          error: `Tool "${toolName}" is not app-visible and cannot be called from an MCP App.`,
        },
        { status: 403 },
      );
    }

    // Forward the call to the MCP server.
    const result = await client.callTool({
      name: toolName,
      arguments: (toolArguments ?? {}) as Record<string, unknown>,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[api/mcp-app-host/call-tool] Failed to call "${toolName}" on "${config.name}": ${message}`,
    );
    return NextResponse.json(
      { error: message },
      { status: 502 },
    );
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.debug(`[route] Error: ${err instanceof Error ? err.message : String(err)}`);
        /* already closed */
      }
    }
  }
}
