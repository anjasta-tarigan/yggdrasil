"use client";

import {
  ArrowLeft,
  ArrowsClockwise,
  ChartBar,
  Download,
  Trash,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useEffect, useMemo, useState } from "react";

/* ── Response types ─────────────────────────────────────────────── */

type SystemStats = {
  collectedAt: string;
  device: {
    hostname: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    cpuCores: number;
    nodeVersion: string;
    nextVersion: string | null;
    processUptimeSeconds: number;
  };
  resources: {
    loadAverage: [number, number, number];
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
    processHeapTotalBytes: number;
    diskTotalBytes: number;
    diskFreeBytes: number;
    databaseSizeBytes: number;
  };
  gpu: {
    name: string;
    memoryUsedMb: number;
    memoryTotalMb: number;
    utilizationPercent: number;
  } | null;
  services: {
    llm: {
      baseUrl: string | null;
      modelId: string | null;
      status: "ok" | "down" | "unconfigured";
      latencyMs: number | null;
    };
    embedding: { provider: string; baseUrl: string | null; model: string | null };
  };
  scheduler: {
    daemonRunning: boolean;
    queueRunnerRunning: boolean;
    cron: Record<string, string>;
  };
  database: {
    chatCount: number;
    messageCount: number;
    memories: { episodic: number; semantic: number; working: number };
    queue: { pending: number; completed: number; failed: number };
    cognitive?: {
      daemonRunning: boolean;
      queueRunnerRunning: boolean;
      relations: number;
      unembedded: { episodic: number; semantic: number };
      lastRuns: Array<{ type: string; at: string | null }>;
      lastFailure: { type: string; error: string | null; at: string | null } | null;
    };
  };
};

type GraphNode = {
  id: string;
  label: string;
  type: "semantic" | "episodic";
  importance: number;
  degree: number;
};

type GraphData = {
  nodes: GraphNode[];
  edges: Array<{
    source: string;
    target: string;
    relationType: string;
    strength: number;
  }>;
  truncated: boolean;
  stats: {
    semanticCount: number;
    episodicCount: number;
    relationCount: number;
    byRelationType: Record<string, number>;
    topHubs: Array<{ id: string; label: string; degree: number }>;
  };
};

type LogEntry = {
  id: number;
  at: string;
  level: "debug" | "info" | "warn" | "error";
  scope: string;
  message: string;
};

/* ── Formatting helpers ─────────────────────────────────────────── */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatWhen(iso: string | null | undefined): string {
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

/* ── Force-directed layout (dependency-free) ────────────────────── */

const GRAPH_W = 800;
const GRAPH_H = 520;

function layoutGraph(
  nodes: GraphNode[],
  edges: GraphData["edges"]
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  if (nodes.length === 1) {
    positions.set(nodes[0].id, { x: GRAPH_W / 2, y: GRAPH_H / 2 });
    return positions;
  }

  // Deterministic circular seed keeps re-renders stable.
  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    const r = Math.min(GRAPH_W, GRAPH_H) * 0.35;
    positions.set(node.id, {
      x: GRAPH_W / 2 + r * Math.cos(angle),
      y: GRAPH_H / 2 + r * Math.sin(angle),
    });
  });

  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const springs = edges
    .map((e) => ({
      a: index.get(e.source),
      b: index.get(e.target),
      strength: Number.isFinite(e.strength) ? e.strength : 0.5,
    }))
    .filter((s): s is { a: number; b: number; strength: number } =>
      s.a !== undefined && s.b !== undefined && s.a !== s.b
    );

  const ids = nodes.map((n) => n.id);
  let temperature = 24;

  for (let iter = 0; iter < 260; iter++) {
    const disp = ids.map(() => ({ dx: 0, dy: 0 }));

    // Pairwise repulsion (fine for the capped node count).
    for (let i = 0; i < ids.length; i++) {
      const pi = positions.get(ids[i])!;
      for (let j = i + 1; j < ids.length; j++) {
        const pj = positions.get(ids[j])!;
        let dx = pi.x - pj.x;
        let dy = pi.y - pj.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          dx = (i - j || 1) * 2;
          dy = 2;
          distSq = dx * dx + dy * dy;
        }
        const force = Math.min(200, 2600 / distSq);
        const dist = Math.sqrt(distSq) || 1;
        disp[i].dx += (dx / dist) * force;
        disp[i].dy += (dy / dist) * force;
        disp[j].dx -= (dx / dist) * force;
        disp[j].dy -= (dy / dist) * force;
      }
    }

    // Spring attraction along edges; stronger relations pull tighter.
    for (const s of springs) {
      const pa = positions.get(ids[s.a])!;
      const pb = positions.get(ids[s.b])!;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist * (0.02 + 0.04 * s.strength)) / 10;
      disp[s.a].dx -= (dx / dist) * force * dist * 0.1;
      disp[s.a].dy -= (dy / dist) * force * dist * 0.1;
      disp[s.b].dx += (dx / dist) * force * dist * 0.1;
      disp[s.b].dy += (dy / dist) * force * dist * 0.1;
    }

    // Gentle centering gravity.
    for (let i = 0; i < ids.length; i++) {
      const p = positions.get(ids[i])!;
      disp[i].dx += (GRAPH_W / 2 - p.x) * 0.012;
      disp[i].dy += (GRAPH_H / 2 - p.y) * 0.012;
    }

    // Apply with a cooling temperature, clamped to the canvas.
    for (let i = 0; i < ids.length; i++) {
      const p = positions.get(ids[i])!;
      const d = disp[i];
      const len = Math.sqrt(d.dx * d.dx + d.dy * d.dy) || 0.01;
      const capped = Math.min(len, temperature);
      p.x = Math.max(20, Math.min(GRAPH_W - 20, p.x + (d.dx / len) * capped));
      p.y = Math.max(20, Math.min(GRAPH_H - 20, p.y + (d.dy / len) * capped));
    }
    temperature *= 0.985;
  }

  return positions;
}

/* ── Small presentational helpers ───────────────────────────────── */

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="truncate font-medium text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

function UsageBar({
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
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${pct >= 90 ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block size-2 rounded-full ${ok ? "bg-emerald-500" : "bg-destructive"}`}
    />
  );
}

const LOG_LEVEL_STYLES: Record<LogEntry["level"], string> = {
  debug: "text-muted-foreground",
  info: "text-foreground",
  warn: "text-amber-500",
  error: "text-destructive",
};

/* ── Main view ──────────────────────────────────────────────────── */

export function StatisticsView({ onBack }: { onBack: () => void }) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphVersion, setGraphVersion] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logLevel, setLogLevel] = useState<"debug" | "info" | "warn" | "error">("debug");
  const [logSearch, setLogSearch] = useState("");
  const [logsBusy, setLogsBusy] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Live stats: poll every 5s with AbortController and monotonic timestamp check.
  useEffect(() => {
    let cancelled = false;
    let latestTimestamp = 0;
    const controller = new AbortController();

    const load = async () => {
      try {
        const res = await fetch("/api/system/stats", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as SystemStats;
        const ts = new Date(data.collectedAt).getTime();
        if (!cancelled && ts >= latestTimestamp) {
          latestTimestamp = ts;
          setStats(data);
        }
      } catch {
        // Transient polling failures are silent.
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  // Knowledge graph: fetch on mount and on manual refresh.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    fetch("/api/system/graph", { cache: "no-store", signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: GraphData | null) => {
        if (!cancelled && data) setGraph(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [graphVersion]);

  // Logs: poll every 3s with active filters, request sequencing, and abortion.
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
        if (!res.ok) return;
        const data = (await res.json()) as { entries?: LogEntry[] };
        if (!cancelled && currentSeq === seq && Array.isArray(data.entries)) {
          setLogs(data.entries);
        }
      } catch {
        // Silent on abort / network retry.
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

  const positions = useMemo(
    () => (graph ? layoutGraph(graph.nodes, graph.edges) : new Map<string, { x: number; y: number }>()),
    [graph]
  );

  const hovered = graph?.nodes.find((n) => n.id === hoveredNode) ?? null;

  const clearLogs = async () => {
    setLogsBusy(true);
    try {
      const res = await fetch("/api/system/logs", { method: "DELETE" });
      if (res.ok) {
        setLogs([]);
      }
    } finally {
      setLogsBusy(false);
    }
  };

  const res = stats?.resources;
  const memUsed = res ? res.memoryTotalBytes - res.memoryFreeBytes : 0;
  const diskUsed = res ? res.diskTotalBytes - res.diskFreeBytes : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <Button onClick={onBack} size="sm" type="button" variant="ghost">
            <ArrowLeft className="size-4" />
            Back to chat
          </Button>
          {stats && (
            <p className="text-muted-foreground text-xs">
              Updated {new Date(stats.collectedAt).toLocaleTimeString()}
            </p>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* ── Device ──────────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ChartBar className="size-4" />
                Device
              </CardTitle>
              <CardDescription>
                The machine this server runs on.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              <StatRow label="Hostname" value={stats?.device.hostname ?? "—"} />
              <StatRow
                label="OS"
                value={
                  stats
                    ? `${stats.device.platform} ${stats.device.osRelease} (${stats.device.arch})`
                    : "—"
                }
              />
              <StatRow
                label="CPU"
                value={
                  stats ? `${stats.device.cpuModel} · ${stats.device.cpuCores} cores` : "—"
                }
              />
              <StatRow label="Node.js" value={stats?.device.nodeVersion ?? "—"} />
              <StatRow label="Next.js" value={stats?.device.nextVersion ?? "—"} />
              <StatRow
                label="Server uptime"
                value={stats ? formatUptime(stats.device.processUptimeSeconds) : "—"}
              />
            </CardContent>
          </Card>

          {/* ── Resources ───────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Resource usage</CardTitle>
              <CardDescription>Live — refreshes every 5 seconds.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {res ? (
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
                      value={res.loadAverage.map((n) => n.toFixed(2)).join(" · ")}
                    />
                    <StatRow label="Process RSS" value={formatBytes(res.processRssBytes)} />
                    <StatRow
                      label="Heap"
                      value={`${formatBytes(res.processHeapUsedBytes)} / ${formatBytes(res.processHeapTotalBytes)}`}
                    />
                    <StatRow label="Database file" value={formatBytes(res.databaseSizeBytes)} />
                  </div>
                  {stats?.gpu && (
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
                <p className="text-muted-foreground">Waiting for first sample…</p>
              )}
            </CardContent>
          </Card>

          {/* ── Services & scheduler ────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>Services &amp; scheduler</CardTitle>
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
                    label="Embedding provider"
                    value={
                      stats.services.embedding.provider +
                      (stats.services.embedding.model
                        ? ` · ${stats.services.embedding.model}`
                        : "")
                    }
                  />
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
                <p className="text-muted-foreground">Waiting for first sample…</p>
              )}
            </CardContent>
          </Card>

          {/* ── Cognitive memory ────────────────────────────────── */}
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
                  <StatRow label="Chats" value={String(stats.database.chatCount)} />
                  <StatRow label="Messages" value={String(stats.database.messageCount)} />
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
                        value={String(stats.database.cognitive.relations)}
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
                <p className="text-muted-foreground">Waiting for first sample…</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Knowledge graph ─────────────────────────────────────── */}
        <Card className="mt-4">
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle>Knowledge graph</CardTitle>
                <CardDescription>
                  Semantic &amp; consolidated episodic memories linked by
                  associative and consolidation relations.
                </CardDescription>
              </div>
              <Button
                onClick={() => setGraphVersion((v) => v + 1)}
                size="sm"
                type="button"
                variant="outline"
              >
                <ArrowsClockwise className="size-3.5" />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {graph && graph.nodes.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
                <div className="rounded-lg border bg-background">
                  <svg
                    className="h-auto w-full"
                    viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
                  >
                    {graph.edges.map((edge) => {
                      const a = positions.get(edge.source);
                      const b = positions.get(edge.target);
                      if (!a || !b) return null;
                      const active =
                        hoveredNode === null ||
                        edge.source === hoveredNode ||
                        edge.target === hoveredNode;
                      return (
                        <line
                          key={`${edge.source}-${edge.target}-${edge.relationType}`}
                          opacity={active ? 0.65 : 0.15}
                          stroke={
                            edge.relationType === "consolidated_into"
                              ? "var(--chart-3)"
                              : "var(--chart-4)"
                          }
                          strokeWidth={0.6 + edge.strength * 1.4}
                          x1={a.x}
                          x2={b.x}
                          y1={a.y}
                          y2={b.y}
                        />
                      );
                    })}
                    {graph.nodes.map((node) => {
                      const p = positions.get(node.id);
                      if (!p) return null;
                      const r = 4 + Math.min(8, node.degree * 1.5);
                      const dimmed = hoveredNode !== null && hoveredNode !== node.id;
                      return (
                        <circle
                          cx={p.x}
                          cy={p.y}
                          fill={
                            node.type === "semantic"
                              ? "var(--chart-1)"
                              : "var(--chart-2)"
                          }
                          key={node.id}
                          onMouseEnter={() => setHoveredNode(node.id)}
                          onMouseLeave={() => setHoveredNode(null)}
                          opacity={dimmed ? 0.25 : 0.95}
                          r={r}
                          stroke="var(--background)"
                          strokeWidth={1}
                        >
                          <title>{`${node.label}\n${node.type} · importance ${node.importance.toFixed(2)} · ${node.degree} links`}</title>
                        </circle>
                      );
                    })}
                    {hovered && positions.get(hovered.id) && (
                      <text
                        className="pointer-events-none"
                        fill="var(--foreground)"
                        fontSize={12}
                        x={Math.min(positions.get(hovered.id)!.x + 10, GRAPH_W - 260)}
                        y={Math.max(positions.get(hovered.id)!.y - 8, 16)}
                      >
                        {hovered.label}
                      </text>
                    )}
                  </svg>
                </div>
                <div className="space-y-1.5 text-sm">
                  <StatRow label="Semantic nodes" value={String(graph.stats.semanticCount)} />
                  <StatRow
                    label="Episodic nodes"
                    value={String(graph.stats.episodicCount)}
                  />
                  <StatRow label="Relations" value={String(graph.stats.relationCount)} />
                  {Object.entries(graph.stats.byRelationType).map(([type, n]) => (
                    <StatRow key={type} label={`· ${type}`} value={String(n)} />
                  ))}
                  {graph.truncated && (
                    <p className="pt-1 text-muted-foreground text-xs">
                      Display capped at {graph.nodes.length} nodes — showing the
                      most connected.
                    </p>
                  )}
                  {graph.stats.topHubs.length > 0 && (
                    <>
                      <p className="pt-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                        Top hubs
                      </p>
                      {graph.stats.topHubs.map((hub) => (
                        <div
                          className="truncate text-xs"
                          key={hub.id}
                          title={hub.label}
                        >
                          <span className="font-medium">{hub.degree} links</span>{" "}
                          <span className="text-muted-foreground">{hub.label}</span>
                        </div>
                      ))}
                    </>
                  )}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <span className="inline-block size-2 rounded-full bg-[var(--chart-1)]" />
                      semantic
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block size-2 rounded-full bg-[var(--chart-2)]" />
                      episodic
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <p className="py-6 text-center text-muted-foreground text-sm">
                {graph
                  ? "No linked memories yet. Knowledge appears here once the dream cycle and consolidation link memories together."
                  : "Loading graph…"}
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── Logs ────────────────────────────────────────────────── */}
        <Card className="mt-4">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle>System logs</CardTitle>
                <CardDescription>
                  Structured events from the cognitive loop, queue runner and
                  daemon. Also mirrored to data/logs/yggdrasil.log.
                </CardDescription>
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
                  onClick={() => void clearLogs()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Trash className="size-3.5" />
                  {logsBusy ? "Clearing…" : "Clear"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              {(["debug", "info", "warn", "error"] as const).map((level) => (
                <Button
                  key={level}
                  onClick={() => setLogLevel(level)}
                  size="sm"
                  type="button"
                  variant={logLevel === level ? "default" : "outline"}
                >
                  ≥ {level}
                </Button>
              ))}
              <Input
                className="max-w-xs"
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Filter by text or scope…"
                value={logSearch}
              />
            </div>
            <div className="max-h-80 overflow-y-auto rounded-lg border bg-muted/30 p-2 font-mono text-xs">
              {logs.length === 0 ? (
                <p className="py-4 text-center text-muted-foreground">
                  No log entries match. Events appear as the cognitive system
                  runs.
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
                      {entry.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
