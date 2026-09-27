import { logsAsText } from "@/lib/observability/log-store";

export const dynamic = "force-dynamic";

/**
 * Plain-text download of the current system-log buffer, for the Statistics
 * page log viewer's Download action.
 */
export async function GET() {
  try {
    const text = logsAsText();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="yggdrasil-logs.txt"',
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[api/system/logs/download] GET error:", error);
    return new Response("Failed to export system logs", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
