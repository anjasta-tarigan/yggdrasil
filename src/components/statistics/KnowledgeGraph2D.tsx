"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as d3Force from "d3-force";
import { scaleOrdinal } from "d3-scale";
import { select } from "d3-selection";
import type { GraphData, GraphNode } from "@/components/statistics/types";

interface KnowledgeGraph2DProps {
  graph: GraphData;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}

type Position = { x: number; y: number };

const VIEW_PADDING = 24;

/**
 * Settles a d3-force simulation synchronously and returns the final node
 * positions — the classic "static force layout" pattern (Bostock). The
 * simulation is never rendered per-tick: it runs to convergence, the
 * result is drawn once, and nothing animates afterwards.
 *
 * d3-force's default random source is a fixed-seed LCG, so the same
 * graph always produces the same layout (no re-scramble on re-render).
 */
function computeForceLayout(
  nodes: GraphNode[],
  edges: { source: string; target: string; strength: number }[],
  width: number,
  height: number
): Map<string, Position> {
  // Clone before handing to d3-force: the simulation mutates its input
  // (adds x/y/vx/vy, rewrites edge endpoints into node references) and
  // the parent's graph data must stay untouched.
  const simNodes = nodes.map((node) => ({ ...node }));
  const simEdges = edges.map((edge) => ({ ...edge }));

  const simulation = d3Force
    .forceSimulation(simNodes as d3Force.SimulationNodeDatum[])
    .force(
      "charge",
      d3Force
        .forceManyBody()
        // Hubs repel harder so dense clusters spread out.
        .strength((d) => -(30 + Math.min((d as GraphNode).degree, 12) * 12))
    )
    .force(
      "link",
      d3Force
        .forceLink(simEdges)
        .id((d) => (d as GraphNode).id)
        // Stronger relations pull their endpoints closer.
        .distance((d) => 70 - (d as { strength: number }).strength * 30)
    )
    .force("x", d3Force.forceX(width / 2).strength(0.05))
    .force("y", d3Force.forceY(height / 2).strength(0.05))
    .force(
      "collide",
      d3Force.forceCollide((d) => 6 + (d as GraphNode).degree * 0.4 + 4)
    )
    .alphaDecay(0.03)
    .stop();

  // Ticks until alpha decays to alphaMin — the whole layout in one pass.
  const ticks = Math.ceil(
    Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay())
  );
  for (let i = 0; i < ticks; i++) simulation.tick();

  const positions = new Map<string, Position>();
  for (const node of simNodes as (GraphNode & Position)[]) {
    // Clamp into the viewport; positioning forces keep drift small, this
    // is just a safety net for runaway hubs.
    positions.set(node.id, {
      x: Math.min(Math.max(node.x, VIEW_PADDING), width - VIEW_PADDING),
      y: Math.min(Math.max(node.y, VIEW_PADDING), height - VIEW_PADDING),
    });
  }
  return positions;
}

/**
 * Static flat 2D knowledge graph.
 *
 * Layout is a precomputed force-directed network (nodes scattered with
 * coordinated placement, clusters forming around hubs) — computed once
 * per graph and cached; hover/selection never recompute it. Labels are
 * hidden by default and appear only on hover or selection.
 */
export function KnowledgeGraph2D({
  graph,
  selectedNodeId,
  onSelectNode,
}: KnowledgeGraph2DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const colorScale = useMemo(
    () =>
      scaleOrdinal<string>()
        .domain(["semantic", "episodic"])
        .range(["#0ea5e9", "#a855f7"]),
    []
  );

  // Layout cache keyed by graph identity: the O(n²)-ish force pass runs
  // once per payload, not on every hover/click re-render.
  const layoutRef = useRef<{ graph: GraphData; positions: Map<string, Position> } | null>(null);

  useEffect(() => {
    if (!containerRef.current || !svgRef.current || graph.nodes.length === 0) return;

    const container = containerRef.current;
    const svg = svgRef.current;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 500;

    if (layoutRef.current?.graph !== graph) {
      layoutRef.current = {
        graph,
        positions: computeForceLayout(graph.nodes, graph.edges, width, height),
      };
    }
    const positions = layoutRef.current.positions;
    const centerX = width / 2;
    const centerY = height / 2;

    // Clear previous content
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width.toString());
    svg.setAttribute("height", height.toString());

    const g = select(svg).append("g");

    // Draw edges (skip edges with unknown endpoints — nothing to draw)
    g.append("g")
      .attr("class", "edges")
      .selectAll("line")
      .data(
        graph.edges.filter(
          (edge) => positions.has(edge.source) && positions.has(edge.target)
        )
      )
      .enter()
      .append("line")
      .attr("x1", (d) => positions.get(d.source)?.x ?? centerX)
      .attr("y1", (d) => positions.get(d.source)?.y ?? centerY)
      .attr("x2", (d) => positions.get(d.target)?.x ?? centerX)
      .attr("y2", (d) => positions.get(d.target)?.y ?? centerY)
      .attr("stroke", (d) =>
        d.relationType === "consolidated_into" ? "#f59e0b" : "#8b5cf6"
      )
      .attr("stroke-opacity", 0.3)
      .attr("stroke-width", (d) => 1 + d.strength * 1.5)
      .attr("stroke-dasharray", (d) =>
        d.relationType === "consolidated_into" ? "4 4" : null
      );

    // Draw nodes
    g.append("g")
      .attr("class", "nodes")
      .selectAll("circle")
      .data(graph.nodes)
      .enter()
      .append("circle")
      .attr("cx", (d) => positions.get(d.id)?.x ?? centerX)
      .attr("cy", (d) => positions.get(d.id)?.y ?? centerY)
      .attr("r", (d) => 6 + d.degree * 0.4)
      .attr("fill", (d) => colorScale(d.type) as string)
      .attr("stroke", (d) => (selectedNodeId === d.id ? "#fff" : "transparent"))
      .attr("stroke-width", (d) => (selectedNodeId === d.id ? 3 : 1.5))
      .attr("cursor", "pointer")
      .on("mouseover", (_event, d) => {
        setHoveredId(d.id);
      })
      .on("mouseout", () => {
        setHoveredId(null);
      })
      .on("click", (event, d) => {
        event.stopPropagation();
        onSelectNode(selectedNodeId === d.id ? null : d.id);
      });

    // Labels (hidden by default; visibility toggled by the hover effect)
    g.append("g")
      .attr("class", "labels")
      .selectAll("text")
      .data(graph.nodes)
      .enter()
      .append("text")
      .attr("x", (d) => positions.get(d.id)?.x ?? centerX)
      .attr("y", (d) => positions.get(d.id)?.y ?? centerY)
      .attr("dy", "-1.2em")
      .attr("text-anchor", "middle")
      .attr("font-size", "11px")
      .attr("fill", "currentColor")
      .style("pointer-events", "none")
      .style("opacity", 0)
      .text((d) => d.label);

    // Background click to deselect
    const handleBgClick = () => onSelectNode(null);
    svg.addEventListener("click", handleBgClick);

    return () => {
      svg.removeEventListener("click", handleBgClick);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    };
  }, [graph, selectedNodeId, onSelectNode, colorScale]);

  // Hover/selection only toggles label opacity — no SVG rebuild, so
  // moving the pointer across the graph stays cheap.
  useEffect(() => {
    if (!svgRef.current) return;
    select(svgRef.current)
      .select("g.labels")
      .selectAll<SVGTextElement, GraphNode>("text")
      .style(
        "opacity",
        (d) => (hoveredId === d.id || selectedNodeId === d.id ? 1 : 0)
      );
  }, [hoveredId, selectedNodeId]);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[500px] relative">
      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ display: "block" }}
      />
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-muted-foreground opacity-60">
        Hover over nodes to see labels
      </div>
    </div>
  );
}
