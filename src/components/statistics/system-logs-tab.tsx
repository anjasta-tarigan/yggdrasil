"use client";

import { Download, Trash, Warning } from "@phosphor-icons/react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useMemo, useState } from "react";
import type { LogEntry, LogLevel } from "@/components/statistics/types";

/**
 * System logs tab — live structured log viewer: level filter with
 * live counts (computed from the current buffer, no extra requests),
 * text search, 3s polling with request sequencing, download and clear.
 */

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

/** Semantic threshold: entries at or above the selected level. */
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_LEVEL_STYLES: Record<LogLevel, string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-warning",
  error: "text-destructive",
};

/** Strips ANSI SGR and cursor/control escape codes so clean text is displayed. */
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function cleanLogText(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function SystemLogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [logLevel, setLogLevel] = useState<LogLevel>("debug");
  const [logSearch, setLogSearch] = useState("");
  const [logsBusy, setLogsBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Poll every 3s with active filters, request sequencing, and abortion.
  useEffect(() => {
    let cancelled = false;
    let seq = 0;
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "300", minLevel: logLevel });
    if (logSearch.trim()) params.set("search", logSearch.trim());

    const load = async () => {
      const currentSeq = ++seq;
      try {
        const res = await fetch(`/api/system/logs?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!cancelled) {
            setLoadError(true);
            setLoading(false);
          }
          return;
        }
        const data = (await res.json()) as { entries?: LogEntry[] };
        if (!cancelled && currentSeq === seq && Array.isArray(data.entries)) {
          setLoadError(false);
          setLogs(data.entries);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [logLevel, logSearch]);

  /**
   * Cumulative per-threshold counts from the current buffer ("≥ warn"
   * counts warn + error), matching the chip labels' semantics. The
   * buffer is already min-level filtered server-side, so counts for
   * thresholds below the selected level reflect only this view.
   */
  const counts = useMemo(() => {
    const c: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    const q = logSearch.trim().toLowerCase();
    for (const entry of logs) {
      const cleanMsg = cleanLogText(entry.message).toLowerCase();
      const cleanScope = cleanLogText(entry.scope).toLowerCase();
      if (q && !cleanMsg.includes(q) && !cleanScope.includes(q)) {
        continue;
      }
      for (const level of LEVELS) {
        if (LEVEL_ORDER[entry.level] >= LEVEL_ORDER[level]) c[level] += 1;
      }
    }
    return c;
  }, [logs, logSearch]);

  const clearLogs = async () => {
    setLogsBusy(true);
    try {
      const res = await fetch("/api/system/logs", { method: "DELETE" });
      if (res.ok) setLogs([]);
    } finally {
      setLogsBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-lg">System logs</h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Structured events from the cognitive loop, queue runner and daemon.
            Also mirrored to data/logs/yggdrasil.log.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => window.open("/api/system/logs/download", "_blank")}
            size="sm"
            type="button"
            variant="outline"
          >
            <Download className="size-3.5" />
            Download
          </Button>
          <Button
            disabled={logsBusy}
            onClick={() => setConfirmClearOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trash className="size-3.5" />
            {logsBusy ? "Clearing…" : "Clear"}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="Clear system logs?"
        description="This will clear all in-memory system logs. This action cannot be undone."
        confirmLabel="Clear logs"
        destructive
        busy={logsBusy}
        onConfirm={async () => {
          await clearLogs();
          setConfirmClearOpen(false);
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div
          aria-label="Minimum log level"
          className="flex flex-wrap gap-1.5"
          role="group"
        >
          {LEVELS.map((level) => (
            <Button
              aria-pressed={logLevel === level}
              className={logLevel === level ? "" : LOG_LEVEL_STYLES[level]}
              key={level}
              onClick={() => setLogLevel(level)}
              size="sm"
              type="button"
              variant={logLevel === level ? "default" : "outline"}
            >
              ≥ {level}
              <span
                className={`rounded-sm px-1 text-xs tabular-nums ${
                  logLevel === level ? "bg-primary-foreground/20" : "bg-muted"
                }`}
              >
                {counts[level]}
              </span>
            </Button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Input
            aria-label="Filter logs by text or scope"
            onChange={(e) => setLogSearch(e.target.value)}
            placeholder="Filter by text or scope…"
            value={logSearch}
          />
        </div>
      </div>

      {loadError && (
        <p className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          <Warning className="size-4 shrink-0" />
          Could not load logs — retrying every few seconds.
        </p>
      )}

      <div
        role="log"
        aria-live="polite"
        aria-label="System logs feed"
        className="max-h-96 overflow-y-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs"
      >
        {loading ? (
          <div className="space-y-2 p-2" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">
            No log entries match. Events appear as the cognitive system runs.
          </p>
        ) : (
          logs.map((entry) => (
            <div className="flex gap-2 py-0.5" key={entry.id}>
              <span className="shrink-0 text-muted-foreground">
                {new Date(entry.at).toLocaleTimeString()}
              </span>
              <span
                className={`w-12 shrink-0 uppercase ${LOG_LEVEL_STYLES[entry.level]}`}
              >
                {entry.level}
              </span>
              <span className="shrink-0 text-muted-foreground">
                [{entry.scope}]
              </span>
              <span className={`break-all ${LOG_LEVEL_STYLES[entry.level]}`}>
                {cleanLogText(entry.message)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
