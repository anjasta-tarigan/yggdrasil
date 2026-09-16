/**
 * Formatting helpers for the Statistics page. Pure functions, shared
 * across tabs (Overview tiles, graph sidebar, log timestamps).
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  let val = bytes / 1024 ** i;

  // Protect against boundary rollover where e.g. 1023.95 KB rounds to 1024.0 KB with toFixed(1).
  if (i > 0 && i < units.length - 1 && Math.round(val * 10) >= 10240) {
    i += 1;
    val = bytes / 1024 ** i;
  }

  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Locale-grouped integer ("12,345"). */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}
