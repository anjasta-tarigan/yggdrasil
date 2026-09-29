import { NextResponse } from "next/server";
import { sqlite } from "@/db";
import { queryLogs } from "@/lib/observability/log-store";

export const dynamic = "force-dynamic";

/** Slow-query threshold in milliseconds. */
export const SLOW_QUERY_THRESHOLD_MS = 100;

interface MaintenanceTiming {
  kind: "optimize" | "vacuum" | "reset";
  durationMs: number;
  detail: string;
  at: string;
}

/**
 * Maintenance timings are emitted to syslog by src/db/maintenance.ts as
 * "completed in <N>ms" lines. Parse them back out so the diagnostics panel
 * aggregates what was actually recorded instead of a buffer nothing writes.
 */
const TIMING_PATTERN =
  /(PRAGMA optimize|VACUUM|Database reset) completed(?: in (\d+)ms)?/;

function collectMaintenanceTimings(): MaintenanceTiming[] {
  // Search the scope text, not a bracketed "[db]": queryLogs matches the
  // needle against scope/message substrings, and scopes are stored bare
  // ("db"), so "[db]" would never match and diagnostics would always read 0.
  const entries = queryLogs({ search: "db", limit: 500 });
  const timings: MaintenanceTiming[] = [];
  for (const entry of entries) {
    const match = TIMING_PATTERN.exec(entry.message);
    if (!match) continue;
    const label = match[1];
    timings.push({
      kind:
        label === "PRAGMA optimize"
          ? "optimize"
          : label === "VACUUM"
            ? "vacuum"
            : "reset",
      durationMs: match[2] ? Number(match[2]) : 0,
      detail: entry.message.slice(0, 150),
      at: entry.at,
    });
  }
  return timings.slice(-50);
}

/**
 * GET /api/maintenance/diagnostics
 *
 * Return maintenance timings recorded in the log store plus slow-operation
 * counts. No separate in-memory query buffer: timings come from the same
 * syslog lines the maintenance functions already emit, so the panel can
 * never drift from reality.
 */
export async function GET() {
  try {
    const timings = collectMaintenanceTimings();
    const slow = timings.filter((t) => t.durationMs > SLOW_QUERY_THRESHOLD_MS);
    const durations = timings.map((t) => t.durationMs);
    return NextResponse.json({
      ok: true,
      metrics: {
        totalOperations: timings.length,
        slowOperations: slow.length,
        avgDurationMs:
          durations.length > 0
            ? Number(
                (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2)
              )
            : 0,
        maxDurationMs: durations.length > 0 ? Math.max(...durations) : 0,
      },
      slowOperations: slow.slice(-5).map((t) => ({
        kind: t.kind,
        durationMs: t.durationMs,
        detail: t.detail,
        at: t.at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/maintenance/diagnostics] GET error:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * POST /api/maintenance/diagnostics
 * Body: { sql: "SELECT ..." }
 *
 * Run EXPLAIN QUERY PLAN for a read-only SELECT so slow queries can be
 * inspected from the settings UI. Anything that is not a single SELECT is
 * rejected — this endpoint must never mutate data.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sql = (body as Record<string, unknown> | null)?.sql;
  if (typeof sql !== "string" || sql.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "sql must be a non-empty string" },
      { status: 400 }
    );
  }

  const normalized = sql.trim().replace(/;+\s*$/, "");
  // Single SELECT (or WITH...SELECT) only. A leading-keyword check alone is
  // not enough: WITH...DELETE/UPDATE/INSERT contains SELECT internally, so
  // additionally reject any write keyword at a statement boundary.
  // (Belt-and-braces: the statement is only ever EXPLAINed, never executed.)
  const isReadOnlySelect =
    /^(SELECT|WITH)\b/i.test(normalized) &&
    !/;/.test(normalized) &&
    !/\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|DROP|ALTER|CREATE|TRUNCATE|VACUUM|REINDEX|ANALYZE|ATTACH|DETACH|PRAGMA)\b/i.test(
      normalized
    );
  if (!isReadOnlySelect) {
    return NextResponse.json(
      { ok: false, error: "Only a single SELECT query is allowed" },
      { status: 400 }
    );
  }

  try {
    // Table/column identifiers come from the caller, but this endpoint only
    // ever prefixes EXPLAIN QUERY PLAN — the statement itself still runs
    // read-only under the SELECT-only gate above.
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${normalized}`).all();
    return NextResponse.json({
      ok: true,
      plan,
      sql: normalized.slice(0, 200),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
