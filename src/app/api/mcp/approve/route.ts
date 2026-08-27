import { NextResponse } from "next/server";
import { refreshMcpBaseline } from "@/lib/ai/mcp/manager";

/**
 * Re-approve an MCP server's current tool definitions.
 *
 * POST { id } — reconnects to the server, fingerprints its current tools
 * and stores the result as the new approved baseline, clearing any
 * recorded drift. Used after the drift detector withheld changed/new
 * tools from the model.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const id =
    typeof body === "object" && body !== null
      ? (body as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string" || !id) {
    return NextResponse.json(
      { error: "Missing MCP server id" },
      { status: 400 }
    );
  }

  const result = await refreshMcpBaseline(id);
  const status = result.ok
    ? 200
    : result.error?.includes("Unknown MCP server")
      ? 404
      : 502;
  return NextResponse.json(result, { status });
}
