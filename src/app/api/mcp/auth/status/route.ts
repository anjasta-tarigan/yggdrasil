import { NextRequest, NextResponse } from "next/server";
import { getMcpServerConfigs } from "@/lib/ai/mcp/manager";
import {
  describeOAuthError,
  oauthErrorCookieName,
  oauthErrorCookieOptions,
} from "@/lib/ai/mcp/oauth-flow";

export const dynamic = "force-dynamic";

/**
 * Poll endpoint: checks whether a server's OAuth auth status has changed
 * to "configured" since the auth flow started.
 *
 * POST { serverName?, serverId?, since? } → { status: "pending" | "complete" | "error" }
 *
 * The callback records terminal failures in a short-lived cookie so this poll
 * can report them even though the popup and the settings tab are different
 * browsing contexts.
 */

interface StatusRequest {
  serverName?: string;
  serverId?: string;
  /** Server-clock start time of the flow; only newer auth counts as complete. */
  since?: number;
}

export async function POST(req: NextRequest) {
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

  const since =
    typeof body.since === "number" && Number.isFinite(body.since)
      ? body.since
      : undefined;

  const servers = getMcpServerConfigs();
  const config = servers.find((s) => serverId ? s.id === serverId : s.name === serverName);

  if (!config) {
    return NextResponse.json({ status: "error", error: "MCP server not found." }, { status: 404 });
  }

  const status = config.auth?.status ?? "not_configured";
  const authenticatedAt = config.auth?.lastAuthenticatedAt ?? 0;
  // A server that was already configured must not report "complete" for a
  // re-authentication attempt before the new tokens land.
  const completed = status === "configured" && (since === undefined || authenticatedAt >= since);

  if (completed) {
    const response = NextResponse.json({ status: "complete" });
    // Drop any stale failure marker from an earlier attempt.
    response.cookies.set(oauthErrorCookieName(config.id), "", {
      ...oauthErrorCookieOptions(req),
      maxAge: 0,
    });
    return response;
  }

  const errorCode = req.cookies.get(oauthErrorCookieName(config.id))?.value;
  if (errorCode) {
    const response = NextResponse.json({
      status: "error",
      error: describeOAuthError(errorCode),
    });
    response.cookies.set(oauthErrorCookieName(config.id), "", {
      ...oauthErrorCookieOptions(req),
      maxAge: 0,
    });
    return response;
  }

  return NextResponse.json({ status: "pending" });
}
