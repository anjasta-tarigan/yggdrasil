"use client";

import { useRef, useEffect, useState } from "react";
import { scaleOrdinal } from "d3-scale";
import { select } from "d3-selection";
import type { GraphData, GraphNode } from "@/components/statistics/types";

interface KnowledgeGraph2DProps {
  graph: GraphData;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}

/**
 * Static 2D knowledge graph using SVG.
 * Nodes are laid out in a circular arrangement.
 * Labels are hidden by default — shown only on hover.
 * No force simulation, no animation, no RAM-eating loops.
 */
export function KnowledgeGraph2D({
  graph,
  selectedNodeId,
  onSelectNode,
}: KnowledgeGraph2DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const colorScale = scaleOrdinal<string>()
    .domain(["semantic", "episodic"])
    .range(["#0ea5e9", "#a855f7"]);

  useEffect(() => {
    if (!containerRef.current || !svgRef.current || graph.nodes.length === 0) return;

    const container = containerRef.current;
    const svg = svgRef.current;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 500;

    // Clear previous content
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width.toString());
    svg.setAttribute("height", height.toString());

    const g = select(svg).append("g");

    // Static circular layout
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.35;

    // Build a node-id → position map
    const nodePositions = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((node, i) => {
      const angle = (i / graph.nodes.length) * 2 * Math.PI - Math.PI / 2;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);
      nodePositions.set(node.id, { x, y });
    });

    // Draw edges
    g.append("g")
      .attr("class", "edges")
      .selectAll("line")
      .data(graph.edges)
      .enter()
      .append("line")
      .attr("x1", (d: any) => nodePositions.get(d.source)?.x ?? centerX)
      .attr("y1", (d: any) => nodePositions.get(d.source)?.y ?? centerY)
      .attr("x2", (d: any) => nodePositions.get(d.target)?.x ?? centerX)
      .attr("y2", (d: any) => nodePositions.get(d.target)?.y ?? centerY)
      .attr("stroke", (d: any) =>
        d.relationType === "consolidated_into" ? "#f59e0b" : "#8b5cf6"
      )
      .attr("stroke-opacity", 0.3)
      .attr("stroke-width", (d: any) => 1 + d.strength * 1.5)
      .attr("stroke-dasharray", (d: any) =>
        d.relationType === "consolidated_into" ? "4 4" : null
      );

    // Draw nodes
    g.append("g")
      .attr("class", "nodes")
      .selectAll("circle")
      .data(graph.nodes)
      .enter()
      .append("circle")
      .attr("cx", (d) => nodePositions.get(d.id)!.x)
      .attr("cy", (d) => nodePositions.get(d.id)!.y)
      .attr("r", (d) => 6 + d.degree * 0.4)
      .attr("fill", (d) => colorScale(d.type) as string)
      .attr("stroke", (d) => (selectedNodeId === d.id ? "#fff" : "transparent"))
      .attr("stroke-width", (d) => (selectedNodeId === d.id ? 3 : 1.5))
      .attr("cursor", "pointer")
      .on("mouseover", (_event: any, d: GraphNode) => {
        setHoveredId(d.id);
      })
      .on("mouseout", () => {
        setHoveredId(null);
      })
      .on("click", (event: any, d: GraphNode) => {
        event.stopPropagation();
        onSelectNode(selectedNodeId === d.id ? null : d.id);
      });

    // Tooltip label (hidden by default, shown on hover via React state)
    g.append("g")
      .attr("class", "labels")
      .selectAll("text")
      .data(graph.nodes)
      .enter()
      .append("text")
      .attr("x", (d) => nodePositions.get(d.id)!.x)
      .attr("y", (d) => nodePositions.get(d.id)!.y)
      .attr("dy", "-1.2em")
      .attr("text-anchor", "middle")
      .attr("font-size", "11px")
      .attr("fill", "currentColor")
      .style("pointer-events", "none")
      .attr("opacity", (d) =>
        hoveredId === d.id || selectedNodeId === d.id ? 1 : 0
      )
      .text((d) => d.label);

    // Background click to deselect
    const handleBgClick = () => onSelectNode(null);
    svg.addEventListener("click", handleBgClick);

    return () => {
      svg.removeEventListener("click", handleBgClick);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    };
  }, [graph, selectedNodeId, hoveredId, onSelectNode, colorScale]);

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
