import { NextResponse } from "next/server";
import { describeOAuthError } from "@/lib/ai/mcp/oauth-flow";

export const dynamic = "force-dynamic";

/**
 * Simple completion page rendered in the OAuth callback tab.
 *
 * On success the page notifies the opener via postMessage and closes itself.
 * On failure it shows the reason and posts an "mcp-auth-error" message so the
 * settings tab can stop polling immediately instead of waiting for its timeout.
 *
 * This route intentionally returns minimal HTML - no external dependencies,
 * no styles - to avoid any security surface area in the redirect target.
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const errorCode = url.searchParams.get("error");
  const serverName = url.searchParams.get("serverName") ?? "server";
  const serverId = url.searchParams.get("serverId");
  const failed = Boolean(errorCode);

  const message = failed
    ? describeOAuthError(errorCode)
    : `Authentication complete for ${serverName}.`;
  const payload = failed
    ? { type: "mcp-auth-error", serverName, serverId, error: message }
    : { type: "mcp-auth-complete", serverName, serverId };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${failed ? "MCP auth failed" : "MCP auth complete"}</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }
    .ok { color: #16a34a; }
    .error { color: #dc2626; }
  </style>
</head>
<body>
  <p class="${failed ? "error" : "ok"}">${failed ? "&#9888;" : "&#10003;"} ${escapeHtml(message)}</p>
  <p>${failed ? "You can close this tab and try again." : "You can close this tab."}</p>
  <script>
    if (window.opener) {
      window.opener.postMessage(${JSON.stringify(payload).replace(/</g, "\\u003c")}, window.location.origin);
    }
    ${failed ? "" : "setTimeout(() => window.close(), 3000);"}
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" :
    "&#39;"
  );
}
