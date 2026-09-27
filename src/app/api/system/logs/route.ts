import { NextResponse } from "next/server";
import { clearLogs, queryLogs, type LogLevel } from "@/lib/observability/log-store";

export const dynamic = "force-dynamic";

/**
 * Structured system-log feed for the Statistics page log viewer.
 *
 * GET    — recent entries (newest last) with optional level/search filters.
 * DELETE — clear the in-memory buffer and the mirrored log files.
 *
 * The store is a bounded in-memory ring buffer mirrored to
 * `data/logs/yggdrasil.log` (see lib/observability/log-store.ts).
 */

const VALID_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rawLevel = url.searchParams.get("minLevel");
    if (rawLevel !== null && !VALID_LEVELS.has(rawLevel)) {
      return NextResponse.json(
        { error: `minLevel must be one of: ${[...VALID_LEVELS].join(", ")}` },
        { status: 400 }
      );
    }

    const rawLimit = url.searchParams.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) {
        return NextResponse.json(
          { error: "limit must be a positive integer" },
          { status: 400 }
        );
      }
    }

    const rawSearch = url.searchParams.get("search");
    const search = rawSearch?.trim() ? rawSearch.trim() : undefined;

    const entries = queryLogs({
      limit,
      minLevel: (rawLevel as LogLevel | null) ?? undefined,
      search,
    });
    return NextResponse.json({ entries });
  } catch (error) {
    console.error("[api/system/logs] GET error:", error);
    return NextResponse.json(
      { error: "Failed to read system logs" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const cleared = clearLogs();
    return NextResponse.json({ cleared });
  } catch (error) {
    console.error("[api/system/logs] DELETE error:", error);
    return NextResponse.json(
      { error: "Failed to clear system logs" },
      { status: 500 }
    );
  }
}
