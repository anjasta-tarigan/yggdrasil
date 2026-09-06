import { NextResponse } from "next/server";
import { MAX_MCP_ENV_VARS } from "@/lib/ai/mcp/config";
import { getMcpServerConfigs } from "@/lib/ai/mcp/manager";
import { writeMcpSecret } from "@/lib/ai/mcp/secrets";

/**
 * Server-side MCP secret writer for the Settings UI.
 *
 * POST { serverId, secrets } — validates that the server exists and that
 * every key is a well-formed env identifier, then writes each value into
 * the shared secrets env file (chmod 600) via writeMcpSecret. Secrets are
 * keyed by env var name so connectMcpServer can overlay them onto stdio
 * env maps at connection time. All failures are logged, never silent.
 */

const SECRET_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SECRET_VALUE_LENGTH = 2048;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    console.warn("[api/mcp/secret] Invalid JSON body:", error);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    console.warn("[api/mcp/secret] Rejected non-object request body");
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }
  const { serverId, secrets } = body as {
    serverId?: unknown;
    secrets?: unknown;
  };

  if (typeof serverId !== "string" || serverId.length === 0) {
    console.warn("[api/mcp/secret] Missing MCP server id");
    return NextResponse.json(
      { error: "Missing MCP server id" },
      { status: 400 }
    );
  }

  let known = false;
  try {
    known = getMcpServerConfigs().some((s) => s.id === serverId);
  } catch (error) {
    console.error("[api/mcp/secret] Failed to read MCP server configs:", error);
    return NextResponse.json(
      { error: "Failed to read MCP server configs" },
      { status: 500 }
    );
  }
  if (!known) {
    console.warn(`[api/mcp/secret] Unknown MCP server id "${serverId}"`);
    return NextResponse.json(
      { error: `Unknown MCP server id "${serverId}"` },
      { status: 404 }
    );
  }

  if (typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
    console.warn(
      `[api/mcp/secret] Invalid secrets payload for server "${serverId}"`
    );
    return NextResponse.json(
      { error: "Invalid secrets payload" },
      { status: 400 }
    );
  }
  const entries = Object.entries(secrets as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_MCP_ENV_VARS) {
    console.warn(
      `[api/mcp/secret] Rejected secrets payload with ${entries.length} entries for server "${serverId}"`
    );
    return NextResponse.json(
      { error: `Provide between 1 and ${MAX_MCP_ENV_VARS} secrets` },
      { status: 400 }
    );
  }
  for (const [key, value] of entries) {
    if (
      !SECRET_KEY_RE.test(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_SECRET_VALUE_LENGTH
    ) {
      console.warn(
        `[api/mcp/secret] Rejected invalid secret key for server "${serverId}"`
      );
      return NextResponse.json(
        { error: "Invalid secret key or value" },
        { status: 400 }
      );
    }
  }

  try {
    for (const [key, value] of entries) {
      await writeMcpSecret(key, value as string);
    }
  } catch (error) {
    console.error(
      `[api/mcp/secret] Failed to write secrets for server "${serverId}":`,
      error
    );
    return NextResponse.json(
      { error: "Failed to store secrets" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
