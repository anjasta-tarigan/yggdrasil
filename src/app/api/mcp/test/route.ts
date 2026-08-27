import { NextResponse } from "next/server";
import {
  createMcpServerId,
  sanitizeMcpServerConfig,
} from "@/lib/ai/mcp/config";
import {
  getMcpServerConfigs,
  testMcpServerConnection,
} from "@/lib/ai/mcp/manager";

/**
 * MCP connection test for the Settings UI.
 *
 * POST { id }       — test an already saved server.
 * POST { config }   — test an unsaved draft config (validated first).
 *
 * Opens a real connection, lists tools, and always closes the client.
 * Never writes baselines or status entries.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { id, config } = body as { id?: unknown; config?: unknown };

  let target;
  if (typeof id === "string" && id) {
    target = getMcpServerConfigs().find((s) => s.id === id);
    if (!target) {
      return NextResponse.json(
        { error: `Unknown MCP server id "${id}"` },
        { status: 404 }
      );
    }
  } else if (config !== undefined) {
    const rawConfig =
      typeof config === "object" && config !== null ? config : {};
    const configId =
      typeof (rawConfig as { id?: unknown }).id === "string" &&
      (rawConfig as { id: string }).id.trim().length > 0
        ? (rawConfig as { id: string }).id
        : createMcpServerId();
    const clean = sanitizeMcpServerConfig({
      ...rawConfig,
      id: configId,
      enabled: true,
    });
    if (!clean) {
      return NextResponse.json(
        { error: "Invalid MCP server config" },
        { status: 400 }
      );
    }
    target = clean;
  } else {
    return NextResponse.json(
      { error: "Provide either a saved server id or a config" },
      { status: 400 }
    );
  }

  const result = await testMcpServerConnection(target);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
