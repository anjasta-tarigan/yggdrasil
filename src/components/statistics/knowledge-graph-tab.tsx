"use client";

import { ArrowsClockwise } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatRow } from "@/components/statistics/primitives";
import type { GraphData, GraphNode } from "@/components/statistics/types";

/**
 * Knowledge graph tab — force-directed SVG visualization of semantic
 * and consolidated episodic memories. Owns its own fetch (mount +
 * manual refresh); the layout runs 260 iterations of a deterministic
 * spring simulation, so it is memoized per graph payload and only
 * computed while this tab is mounted.
 */

const GRAPH_W = 800;
const GRAPH_H = 520;

export function KnowledgeGraphTab() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [graphVersion, setGraphVersion] = useState(0);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const load = useCallback((signal: AbortSignal) => {
    fetch("/api/system/graph", { cache: "no-store", signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: GraphData | null) => {
        if (signal.aborted) return;
        if (data) {
          setGraph(data);
          setLoadError(false);
        } else {
          setLoadError(true);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, graphVersion]);

  // Expensive layout: recompute only when the graph payload changes.
  const positions = useMemo(
    () =>
      graph ? layoutGraph(graph.nodes, graph.edges) : new Map<string, { x: number; y: number }>(),
    [graph]
  );

  const hovered = graph?.nodes.find((n) => n.id === hoveredNode) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-lg">Knowledge graph</h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Semantic & consolidated episodic memories linked by associative
            and consolidation relations.
          </p>
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
                      node.type === "semantic" ? "var(--chart-1)" : "var(--chart-2)"
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
            <StatRow label="Episodic nodes" value={String(graph.stats.episodicCount)} />
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
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
          {graph ? (
            <p className="max-w-md text-muted-foreground text-sm">
              No linked memories yet. Knowledge appears here once the dream
              cycle and consolidation link memories together.
            </p>
          ) : loadError ? (
            <p className="max-w-md text-muted-foreground text-sm">
              Could not load the knowledge graph. Try refreshing.
            </p>
          ) : (
            <div className="w-full max-w-2xl space-y-2" aria-hidden="true">
              <div className="h-52 rounded-lg bg-muted" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Force-directed layout (dependency-free) ─────────────────────── */

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
