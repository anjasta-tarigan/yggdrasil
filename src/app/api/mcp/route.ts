import { NextResponse } from "next/server";
import {
  getMcpBaselines,
  getMcpServerConfigs,
  getMcpStatusMap,
} from "@/lib/ai/mcp/manager";
import { maskMcpServerConfig } from "@/lib/ai/mcp/secrets";

/**
 * MCP server registry snapshot for the Settings UI.
 *
 * GET returns the configured servers, the last known connection status
 * per server (recorded by chat-time tool collection and test/approve
 * actions) and a summary of the approved tool baselines. It never opens
 * connections itself.
 */
export async function GET() {
  let servers;
  let status;
  let baselines;
  try {
    servers = getMcpServerConfigs();
    status = getMcpStatusMap();
    baselines = getMcpBaselines();
  } catch (error) {
    console.error("[api/mcp] Failed to read MCP settings:", error);
    return NextResponse.json(
      { error: "Failed to read MCP settings" },
      { status: 500 }
    );
  }

  const baselineSummary: Record<
    string,
    { updatedAt: string; toolCount: number }
  > = {};
  for (const [serverId, entry] of Object.entries(baselines)) {
    if (
      entry &&
      typeof entry === "object" &&
      entry.fingerprints &&
      typeof entry.fingerprints === "object"
    ) {
      baselineSummary[serverId] = {
        updatedAt: entry.updatedAt,
        toolCount: Object.keys(entry.fingerprints).length,
      };
    }
  }

  const maskedServers = servers.map(maskMcpServerConfig);

  return NextResponse.json({ servers: maskedServers, status, baselines: baselineSummary });
}
