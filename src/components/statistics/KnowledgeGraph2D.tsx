"use client";

import { useRef, useEffect, useState, useCallback } from "react";
import * as d3Force from "d3-force";
import { scaleOrdinal } from "d3-scale";
import { select } from "d3-selection";
import type { GraphData, GraphNode } from "@/components/statistics/types";

interface KnowledgeGraph2DProps {
  graph: GraphData;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}

/**
 * 2D force-directed graph using D3.
 * Fast, responsive, and supports hover/click selection.
 */
export function KnowledgeGraph2D({
  graph,
  selectedNodeId,
  onSelectNode,
}: KnowledgeGraph2DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Color scale for node types
  const colorScale = scaleOrdinal<string>()
    .domain(["semantic", "episodic"])
    .range(["#0ea5e9", "#a855f7"]);

  useEffect(() => {
    if (!containerRef.current || !svgRef.current || graph.nodes.length === 0) return;

    const container = containerRef.current;
    const svg = svgRef.current;
    const width = container.clientWidth || 600;
    const height = container.clientHeight || 500;

    // Clear previous SVG content
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Set SVG viewBox
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width.toString());
    svg.setAttribute("height", height.toString());

    // Create D3 force simulation
    const simulation = d3Force
      .forceSimulation(graph.nodes as any)
      .force(
        "charge",
        d3Force.forceManyBody().strength((d: any) => {
          // Stronger repulsion for high-degree nodes to avoid overlap
          return -30 - (d.degree || 0) * 2;
        })
      )
      .force(
        "link",
        d3Force
          .forceLink(graph.edges)
          .id((d: any) => d.id)
          .distance((d: any) => 60 + d.strength * 40)
      )
      .force("center", d3Force.forceCenter(width / 2, height / 2))
      .force("collision", d3Force.forceCollide().radius((d: any) => 12 + (d.degree || 0) * 0.5))
      .alphaDecay(0.05)
      .alphaMin(0.001);

    // Create SVG groups
    const g = select(svg).append("g");

    // Draw edges (links)
    const linkGroup = g.append("g").attr("class", "edges");
    const linkElements = linkGroup
      .selectAll("line")
      .data(graph.edges)
      .enter()
      .append("line")
      .attr("stroke", (d: any) => {
        return d.relationType === "consolidated_into" ? "#f59e0b" : "#8b5cf6";
      })
      .attr("stroke-opacity", 0.4)
      .attr("stroke-width", (d: any) => 1 + d.strength * 2)
      .attr("stroke-dasharray", (d: any) =>
        d.relationType === "consolidated_into" ? "4 4" : null
      );

    // Draw nodes
    const nodeGroup = g.append("g").attr("class", "nodes");

    // Node circles
    const nodeElements = nodeGroup
      .selectAll("circle")
      .data(graph.nodes)
      .enter()
      .append("circle")
      .attr("r", (d: any) => 6 + (d.degree || 0) * 0.4)
      .attr("fill", (d: any) => colorScale(d.type) as string)
      .attr("stroke", "#fff")
      .attr("stroke-width", 1.5)
      .attr("cursor", "pointer")
      .on("mouseover", (event: any, d: any) => {
        setHoveredId(d.id);
      })
      .on("mouseout", () => {
        setHoveredId(null);
      })
      .on("click", (event: any, d: any) => {
        event.stopPropagation();
        onSelectNode(selectedNodeId === d.id ? null : d.id);
      });

    // Node labels
    const labelGroup = g.append("g").attr("class", "labels");
    const labelElements = labelGroup
      .selectAll("text")
      .data(graph.nodes)
      .enter()
      .append("text")
      .attr("dy", "0.35em")
      .attr("text-anchor", "middle")
      .attr("font-size", (d: any) => Math.max(8, 10 - (d.degree || 0) * 0.1))
      .attr("fill", "#888")
      .style("pointer-events", "none")
      .text((d: any) => d.label);

    // Selection highlight
    const selectionGroup = g.append("g").attr("class", "selection");
    const selectionElement = selectionGroup
      .selectAll("circle")
      .data(graph.nodes.filter((n) => n.id === selectedNodeId))
      .enter()
      .append("circle")
      .attr("r", (d: any) => 8 + (d.degree || 0) * 0.4)
      .attr("fill", "none")
      .attr("stroke", "#fff")
      .attr("stroke-width", 3)
      .style("opacity", 0.8);

    // Hover glow
    const hoverGroup = g.append("g").attr("class", "hover");
    const hoverElement = hoverGroup
      .selectAll("circle")
      .data(graph.nodes.filter((n) => n.id === hoveredId))
      .enter()
      .append("circle")
      .attr("r", (d: any) => 8 + (d.degree || 0) * 0.4)
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.4)")
      .attr("stroke-width", 2)
      .style("opacity", 0.6);

    // Update simulation on each tick
    simulation.on("tick", () => {
      // Update links
      linkElements
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);

      // Update nodes
      nodeElements.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);
      labelElements.attr("x", (d: any) => d.x).attr("y", (d: any) => d.y);

      // Update selection highlight (if any)
      selectionElement
        .attr("cx", (d: any) => d.x)
        .attr("cy", (d: any) => d.y)
        .attr("r", (d: any) => 8 + (d.degree || 0) * 0.4);

      // Update hover highlight
      hoverElement
        .attr("cx", (d: any) => d.x)
        .attr("cy", (d: any) => d.y)
        .attr("r", (d: any) => 8 + (d.degree || 0) * 0.4);
    });

    // Click on background to deselect
    svg.addEventListener("click", () => {
      onSelectNode(null);
    });

    // Cleanup
    return () => {
      simulation.stop();
      // Remove event listener
      svg.removeEventListener("click", () => {});
      while (svg.firstChild) svg.removeChild(svg.firstChild);
    };
  }, [graph, selectedNodeId, hoveredId, onSelectNode, colorScale]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[500px] relative"
    >
      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ display: "block" }}
      />
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-muted-foreground opacity-60">
        Drag to pan · Scroll to zoom
      </div>
    </div>
  );
}