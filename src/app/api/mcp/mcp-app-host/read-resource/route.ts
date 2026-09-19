import { NextResponse } from "next/server";
import { readMCPAppResource } from "@ai-sdk/mcp";
import {
  connectMcpServer,
  getMcpServerConfigs,
} from "@/lib/ai/mcp/manager";

/**
 * Read a `ui://` MCP App resource from a connected server.
 *
 * GET query params:
 *   uri      — the `ui://` resource URI (required, validated against ui:// scheme)
 *   serverId — MCP server id to read from (required for multi-server hosts)
 *
 * Returns the normalized `MCPAppResource` (`{ uri, mimeType, html, meta }`)
 * including rendering metadata such as CSP.
 *
 * Security: only `ui://` URIs are accepted. The route never reads
 * arbitrary `mcp://` or other scheme resources — those stay on the
 * MCP server side and are not app-rendered.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const uri = searchParams.get("uri");
  const serverId = searchParams.get("serverId");

  if (!uri) {
    return NextResponse.json(
      { error: "Missing required 'uri' query parameter" },
      { status: 400 },
    );
  }

  // Security: reject non-ui:// URIs — only app-rendered resources are served.
  if (!uri.startsWith("ui://")) {
    return NextResponse.json(
      { error: `Only ui:// resource URIs are allowed, got: ${uri}` },
      { status: 403 },
    );
  }

  if (!serverId) {
    return NextResponse.json(
      { error: "Missing required 'serverId' query parameter" },
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
    const resource = await readMCPAppResource({ client, uri });
    return NextResponse.json(resource);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.warn(
      `[api/mcp-app-host/read-resource] Failed to read "${uri}" from "${config.name}": ${message}`,
    );
    return NextResponse.json(
      { error: message },
      { status: 400 },
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

/**
 * POST variant: same behavior but reads `uri` and `serverId` from the
 * JSON body. Lets the iframe bridge (which posts JSON-RPC requests)
 * proxy resources/read through fetch with a POST body.
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
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { uri, serverId } = body as { uri?: unknown; serverId?: unknown };

  if (typeof uri !== "string" || !uri) {
    return NextResponse.json(
      { error: "Missing or invalid 'uri' in request body" },
      { status: 400 },
    );
  }

  // Security: reject non-ui:// URIs.
  if (!uri.startsWith("ui://")) {
    return NextResponse.json(
      { error: `Only ui:// resource URIs are allowed, got: ${uri}` },
      { status: 403 },
    );
  }

  if (typeof serverId !== "string" || !serverId) {
    return NextResponse.json(
      { error: "Missing or invalid 'serverId' in request body" },
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
    const resource = await readMCPAppResource({ client, uri });
    return NextResponse.json(resource);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.warn(
      `[api/mcp-app-host/read-resource] Failed to read "${uri}" from "${config.name}": ${message}`,
    );
    return NextResponse.json(
      { error: message },
      { status: 400 },
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
