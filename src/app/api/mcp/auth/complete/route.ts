import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Simple completion page rendered in the OAuth callback tab.
 *
 * The page uses postMessage to notify the opener window that auth completed,
 * then auto-closes itself after a short delay.
 *
 * This route intentionally returns minimal HTML — no external dependencies,
 * no styles — to avoid any security surface area in the redirect target.
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const serverName = url.searchParams.get("serverName") ?? "server";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>MCP auth complete</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }
    .ok { color: #16a34a; }
  </style>
</head>
<body>
  <p class="ok">✓ Authentication complete for ${escapeHtml(serverName)}.</p>
  <p>You can close this tab.</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: "mcp-auth-complete", serverName: ${JSON.stringify(serverName)} }, "*");
    }
    setTimeout(() => window.close(), 3000);
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
