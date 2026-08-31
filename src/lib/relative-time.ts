/**
 * Relative timestamp formatting for chat history rows ("1 min ago",
 * "3 hours ago", "2 days ago"). Deliberately dependency-free — mirrors
 * the Intl.RelativeTimeFormat pattern already used by CommitTimestamp,
 * but with minute/hour granularity (that one only formats whole days).
 *
 * Granularity ladder (matches how people think about chat recency):
 *   < 1 min      → "just now"
 *   < 1 hour     → "N min ago"          (5 min ago)
 *   < 24 hours   → "N hours ago"        (3 hours ago)
 *   < 7 days     → "N days ago"         (2 days ago)
 *   < 30 days    → "N weeks ago"        (1 week ago)
 *   otherwise    → absolute short date  (Mar 12) — relative units past a
 *                  month read worse than a real date.
 */

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const shortDateFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
});

/** Format a past timestamp as a compact relative label. */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const age = now - timestamp;

  if (age < MINUTE) return "just now";
  if (age < HOUR) return rtf.format(-Math.floor(age / MINUTE), "minute");
  if (age < DAY) return rtf.format(-Math.floor(age / HOUR), "hour");
  if (age < WEEK) return rtf.format(-Math.floor(age / DAY), "day");
  if (age < 30 * DAY) return rtf.format(-Math.floor(age / WEEK), "week");

  return shortDateFormat.format(new Date(timestamp));
}
