import { NextRequest, NextResponse } from "next/server";
import { assertSafeUrl, secureFetch } from "@/lib/security/ssrf";

export const dynamic = "force-dynamic";

const SMITHERY_API_BASE = "https://api.smithery.ai";

export interface ServerConnectionDetail {
  qualifiedName: string;
  displayName: string;
  description: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  configSchema?: {
    properties?: Record<
      string,
      {
        type?: string;
        description?: string;
        default?: string;
        required?: boolean;
      }
    >;
    required?: string[];
  };
  verified: boolean;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const qualifiedName = url.searchParams.get("qualifiedName")?.trim();

  if (!qualifiedName) {
    return NextResponse.json(
      { error: "Missing 'qualifiedName' parameter" },
      { status: 400 }
    );
  }

  // Smithery endpoint is GET /servers/{namespace}/{slug} or GET /servers/{name}
  const targetUrl = `${SMITHERY_API_BASE}/servers/${encodeURIComponent(qualifiedName)}`;

  let response: Response;
  try {
    response = await secureFetch(targetUrl, {
      timeoutMs: 10_000,
      headers: {
        Accept: "application/json",
        "User-Agent": "Yggdrasil-MCP-Marketplace/1.0",
      },
    });
  } catch (err) {
    console.warn(
      `[api/mcp/marketplace/detail] Failed to fetch details for "${qualifiedName}":`,
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { error: "Failed to connect to Smithery registry" },
      { status: 502 }
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { error: `Smithery returned ${response.status}: ${response.statusText}` },
      { status: response.status }
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON received from Smithery" },
      { status: 502 }
    );
  }

  const displayName = typeof data.displayName === "string" ? data.displayName : qualifiedName;
  const description = typeof data.description === "string" ? data.description : "";
  const verified = data.verified === true;
  const deploymentUrl = typeof data.deploymentUrl === "string" ? data.deploymentUrl : undefined;

  const connections = Array.isArray(data.connections)
    ? (data.connections as Record<string, unknown>[])
    : [];

  let transport: "http" | "stdio" = "stdio";
  let targetEndpoint: string | undefined = deploymentUrl;
  let command: string | undefined;
  let args: string[] | undefined;
  let configSchema: ServerConnectionDetail["configSchema"];

  const httpConn = connections.find((c) => c.type === "http");
  if (httpConn && typeof httpConn.deploymentUrl === "string") {
    transport = "http";
    targetEndpoint = httpConn.deploymentUrl;
    configSchema = httpConn.configSchema as ServerConnectionDetail["configSchema"];
  } else {
    // stdio fallback
    transport = "stdio";
    command = `npx -y @smithery/cli run ${qualifiedName}`;
  }

  // Safety invariant: if HTTP endpoint is returned, assert it doesn't violate SSRF
  if (targetEndpoint) {
    try {
      await assertSafeUrl(targetEndpoint);
    } catch (ssrfErr) {
      console.warn(
        `[api/mcp/marketplace/detail] Rejected unsafe deploymentUrl for "${qualifiedName}":`,
        targetEndpoint,
        ssrfErr
      );
      return NextResponse.json(
        { error: "Server deployment URL failed security validation" },
        { status: 400 }
      );
    }
  }

  const detail: ServerConnectionDetail = {
    qualifiedName,
    displayName,
    description,
    transport,
    url: targetEndpoint,
    command,
    args,
    configSchema,
    verified,
  };

  return NextResponse.json(detail);
}
