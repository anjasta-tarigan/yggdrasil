"use client";

import { Brain, Chats, ChartBar, ClockClockwise, Database, Warning, ArrowsClockwise } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  StatRow,
  StatSkeleton,
  StatusDot,
  UsageBar,
} from "@/components/statistics/primitives";
import { formatBytes, formatCount, formatUptime, formatWhen } from "@/components/statistics/format";
import type { SystemStats } from "@/components/statistics/types";

/**
 * Overview tab — the live system dashboard: hero stat tiles plus the
 * Device / Resources / Services / Cognitive memory cards. Data is owned
 * by the parent (single 5s poll); this tab is purely presentational.
 */

export function OverviewTab({
  stats,
  error = false,
  onRetry,
}: {
  stats: SystemStats | null;
  error?: boolean;
  onRetry?: () => void;
}) {
  if (!stats && error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-6 py-12 text-center">
        <Warning className="size-8 text-destructive" />
        <div className="space-y-1">
          <p className="font-medium text-sm text-foreground">
            Could not load system statistics
          </p>
          <p className="text-muted-foreground text-xs">
            Failed to retrieve live system vitals. The endpoint may be unreachable.
          </p>
        </div>
        {onRetry && (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            <ArrowsClockwise className="size-3.5" />
            Retry
          </Button>
        )}
      </div>
    );
  }

  const res = stats?.resources ?? null;
  // Use memoryAvailableBytes if provided (accurate on Linux, fallback on Win/Mac), else memoryFreeBytes
  const availableMem = res?.memoryAvailableBytes ?? res?.memoryFreeBytes ?? 0;
  const memUsed = res ? Math.max(0, res.memoryTotalBytes - availableMem) : 0;
  const diskUsed = res ? Math.max(0, res.diskTotalBytes - res.diskFreeBytes) : 0;
  const db = stats?.database ?? null;

  const tiles = stats
    ? [
        { icon: Chats, label: "Chats", value: formatCount(db?.chatCount ?? 0) },
        { icon: Database, label: "Messages", value: formatCount(db?.messageCount ?? 0) },
        {
          icon: Brain,
          label: "Memories",
          value: formatCount(
            (db?.memories.episodic ?? 0) +
              (db?.memories.semantic ?? 0) +
              (db?.memories.working ?? 0)
          ),
        },
        {
          icon: ClockClockwise,
          label: "Queue pending",
          value: formatCount(db?.queue.pending ?? 0),
        },
      ]
    : null;

  return (
    <div className="space-y-4">
      {/* ── Hero stat tiles ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(tiles ?? Array.from({ length: 4 }, () => null)).map((tile, i) => (
          <div className="rounded-lg border px-3 py-2.5" key={tile?.label ?? `skeleton-${i}`}>
            {tile ? (
              <>
                <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
                  <tile.icon className="size-3.5" />
                  {tile.label}
                </p>
                <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                  {tile.value}
                </p>
              </>
            ) : (
              <div aria-hidden="true">
                <div className="h-3 w-16 rounded-sm bg-muted" />
                <div className="mt-2 h-6 w-20 rounded-sm bg-muted/80" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Live cards ─────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ChartBar className="size-4" />
              Device
            </CardTitle>
            <CardDescription>The machine this server runs on.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {stats ? (
              <>
                <StatRow label="Hostname" value={stats.device.hostname} />
                <StatRow
                  label="OS"
                  value={`${stats.device.platform} ${stats.device.osRelease} (${stats.device.arch})`}
                />
                <StatRow
                  label="CPU"
                  value={`${stats.device.cpuModel} · ${stats.device.cpuCores} cores`}
                />
                <StatRow label="Node.js" value={stats.device.nodeVersion} />
                <StatRow label="Next.js" value={stats.device.nextVersion ?? "—"} />
                <StatRow
                  label="Server uptime"
                  value={formatUptime(stats.device.processUptimeSeconds)}
                />
              </>
            ) : (
              <StatSkeleton rows={6} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Resource usage</CardTitle>
            <CardDescription>Live — refreshes every 5 seconds.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {res && stats ? (
              <>
                <UsageBar
                  label="System memory"
                  used={memUsed}
                  total={res.memoryTotalBytes}
                  detail={`${formatBytes(memUsed)} / ${formatBytes(res.memoryTotalBytes)}`}
                />
                <UsageBar
                  label="Disk (database volume)"
                  used={diskUsed}
                  total={res.diskTotalBytes}
                  detail={`${formatBytes(diskUsed)} / ${formatBytes(res.diskTotalBytes)}`}
                />
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 pt-1">
                  <StatRow
                    label="Load avg"
                    value={
                      stats.device.platform === "win32" && res.loadAverage.every((n) => n === 0)
                        ? "N/A (Windows)"
                        : `${res.loadAverage.map((n) => n.toFixed(2)).join(" · ")} (${stats.device.cpuCores}c)`
                    }
                  />
                  <StatRow label="Process RSS" value={formatBytes(res.processRssBytes)} />
                  <StatRow
                    label="Heap"
                    value={`${formatBytes(res.processHeapUsedBytes)} / ${formatBytes(res.processHeapTotalBytes)}`}
                  />
                  <StatRow label="Database file" value={formatBytes(res.databaseSizeBytes)} />
                </div>
                {stats.gpu && (
                  <div className="rounded-lg border p-3">
                    <p className="mb-2 font-medium text-sm">{stats.gpu.name}</p>
                    <UsageBar
                      label="VRAM"
                      used={stats.gpu.memoryUsedMb}
                      total={stats.gpu.memoryTotalMb}
                      detail={`${stats.gpu.memoryUsedMb} / ${stats.gpu.memoryTotalMb} MiB`}
                    />
                    <div className="mt-1.5">
                      <StatRow
                        label="GPU utilization"
                        value={`${stats.gpu.utilizationPercent}%`}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <StatSkeleton rows={4} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Services & scheduler</CardTitle>
            <CardDescription>
              Model endpoints and the autonomous maintenance daemon.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {stats ? (
              <>
                <div className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <StatusDot ok={stats.services.llm.status === "ok"} />
                    LLM endpoint
                  </span>
                  <span className="truncate font-medium text-right">
                    {stats.services.llm.status === "ok"
                      ? `online${stats.services.llm.latencyMs !== null ? ` · ${stats.services.llm.latencyMs} ms` : ""}`
                      : stats.services.llm.status}
                  </span>
                </div>
                <StatRow label="Model" value={stats.services.llm.modelId ?? "—"} />
                <StatRow label="LLM base URL" value={stats.services.llm.baseUrl ?? "—"} />
                <StatRow
                  label="Embedding"
                  value={
                    stats.services.embedding.provider +
                    (stats.services.embedding.model
                      ? ` · ${stats.services.embedding.model}`
                      : "") +
                    (stats.services.embedding.loaded !== undefined
                      ? stats.services.embedding.loaded
                        ? " · active"
                        : " · standby"
                      : "")
                  }
                />
                {stats.services.reranker && (
                  <StatRow
                    label="Reranker"
                    value={
                      !stats.services.reranker.enabled
                        ? "disabled"
                        : stats.services.reranker.status === "fallback"
                          ? "fallback (no model)"
                          : `${stats.services.reranker.model ?? "default"} · ${stats.services.reranker.status}`
                    }
                  />
                )}
                <div className="my-2 border-t" />
                <StatRow
                  label="Queue runner"
                  value={stats.scheduler.queueRunnerRunning ? "running" : "stopped"}
                />
                <StatRow
                  label="Cron daemon"
                  value={stats.scheduler.daemonRunning ? "running" : "stopped"}
                />
                {Object.entries(stats.scheduler.cron).map(([name, expr]) => (
                  <StatRow key={name} label={`Cron · ${name}`} value={expr} />
                ))}
              </>
            ) : (
              <StatSkeleton rows={6} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cognitive memory</CardTitle>
            <CardDescription>
              What the assistant currently knows and has pending.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {stats ? (
              <>
                <StatRow label="Chats" value={formatCount(stats.database.chatCount)} />
                <StatRow label="Messages" value={formatCount(stats.database.messageCount)} />
                <StatRow
                  label="Memories"
                  value={`${stats.database.memories.episodic} episodic · ${stats.database.memories.semantic} semantic · ${stats.database.memories.working} working`}
                />
                <StatRow
                  label="Job queue"
                  value={`${stats.database.queue.completed} completed · ${stats.database.queue.pending} pending · ${stats.database.queue.failed} failed`}
                />
                {stats.database.cognitive && (
                  <>
                    <StatRow
                      label="Memory relations"
                      value={formatCount(stats.database.cognitive.relations)}
                    />
                    <StatRow
                      label="Embedding backlog"
                      value={`${stats.database.cognitive.unembedded.episodic} episodic · ${stats.database.cognitive.unembedded.semantic} semantic`}
                    />
                    <StatRow
                      label="Last failure"
                      value={
                        stats.database.cognitive.lastFailure
                          ? `${stats.database.cognitive.lastFailure.type} (${formatWhen(stats.database.cognitive.lastFailure.at)})`
                          : "none"
                      }
                    />
                  </>
                )}
              </>
            ) : (
              <StatSkeleton rows={5} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
