/**
 * Small presentational primitives shared by the Statistics tabs.
 * Kept presentational-only: no fetching, no effects. Cards themselves
 * compose from components/ui/card (shadcn) — these are the row-level
 * pieces below the card chrome.
 */

export function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-medium text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

export function UsageBar({
  label,
  used,
  total,
  detail,
}: {
  label: string;
  used: number;
  total: number;
  detail: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-4">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium" title={detail}>
          {detail}
        </span>
      </div>
      <div
        aria-hidden="true"
        aria-label={`${label}: ${pct}% used`}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full transition-all ${pct >= 90 ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 rounded-full ${ok ? "bg-success" : "bg-destructive"}`}
    />
  );
}

/** Card-body skeleton rows (n bars) shown until the first sample lands. */
export function StatSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          className="flex items-baseline justify-between gap-4"
          key={i}
        >
          <div className="h-3 w-20 rounded-sm bg-muted" />
          <div
            className="h-3 rounded-sm bg-muted/80"
            style={{ width: `${28 + ((i * 17) % 40)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
