import { NextResponse } from "next/server";
import { getMcpServerConfigs } from "@/lib/ai/mcp/manager";

export const dynamic = "force-dynamic";

/**
 * Poll endpoint: checks whether a server's OAuth auth status has changed
 * to "configured" since the auth flow started.
 *
 * POST { serverName } → { status: "pending" | "complete" | "error" }
 */

interface StatusRequest {
  serverName?: string;
  serverId?: string;
}

export async function POST(req: Request) {
  let body: StatusRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { serverName, serverId } = body;
  if ((!serverName || typeof serverName !== "string") && (!serverId || typeof serverId !== "string")) {
    return NextResponse.json({ error: "Missing serverId" }, { status: 400 });
  }

  const servers = getMcpServerConfigs();
  const config = servers.find((s) => serverId ? s.id === serverId : s.name === serverName);

  if (!config) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const status = config.auth?.status ?? "not_configured";

  if (status === "configured") {
    return NextResponse.json({ status: "complete" });
  }

  return NextResponse.json({ status: "pending" });
}
