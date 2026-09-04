"use client";

import { ArrowsClockwise, MagnifyingGlass, X, Cube, GridFour } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatRow } from "@/components/statistics/primitives";
import type { GraphData, GraphNode } from "@/components/statistics/types";
import { KnowledgeGraphGlobe } from "./KnowledgeGraphGlobe";
import { KnowledgeGraph2D } from "./KnowledgeGraph2D";

/**
 * Knowledge graph tab — 3D globe visualization of semantic and
 * consolidated episodic memories using Three.js.
 *
 * Owns its own fetch (mount + manual refresh + filter changes); the
 * globe layout is a Fibonacci sphere with spring‑like edge curves.
 *
 * Interaction model:
 *   • Relation-type / node-type chips and the search box re-query the
 *     server (filters are applied SQL-side; stats stay global).
 *   • Hover highlights a node; click pins the selection and shows full
 *     details (tags, importance, degree, timestamps) in the side panel.
 *   • Drag to rotate the globe, scroll to zoom.
 *
 * Memory-safety: every fetch goes through one AbortController kept in
 * a ref and aborted on unmount AND before each new request, so a slow
 * filter response can never land after the next one or after unmount.
 */



type RelationFilter = string[] | null; // null = all
type NodeFilter = "all" | "semantic" | "episodic";

function formatTimestamp(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function KnowledgeGraphTab() {
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [graphVersion, setGraphVersion] = useState(0);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");

  // Filters (server-applied). relationTypes: null = no restriction.
  const [relationFilter, setRelationFilter] = useState<RelationFilter>(null);
  const [nodeFilter, setNodeFilter] = useState<NodeFilter>("all");
  // Debounced search input: `searchInput` is the field, `search` is what
  // goes to the server. A 300ms debounce keeps keystrokes cheap; the
  // timer is cleared on every keystroke and on unmount.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);



  // Active-fetch controller: aborted by cleanup AND reused across
  // effect runs so only one in-flight request exists at a time.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams();
      if (relationFilter) params.set("relationTypes", relationFilter.join(","));
      if (nodeFilter !== "all") params.set("nodeTypes", nodeFilter);
      if (search) params.set("search", search);
      const qs = params.size > 0 ? `?${params.toString()}` : "";
      fetch(`/api/system/graph${qs}`, { cache: "no-store", signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: GraphData | null) => {
          if (signal.aborted) return;
          if (data) {
            setGraph(data);
            // A new payload resets selection.
            setSelectedNode(null);
            setLoadError(false);
          } else {
            setLoadError(true);
          }
        })
        .catch(() => undefined);
    },
    [relationFilter, nodeFilter, search]
  );

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    load(controller.signal);
    return () => controller.abort();
  }, [load, graphVersion]);

  // Abandon any request still in flight when the tab unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);




  const selected = graph?.nodes.find((n) => n.id === selectedNode) ?? null;
  const filteredOut =
    relationFilter !== null || nodeFilter !== "all" || search.length > 0;

  const toggleRelation = useCallback((type: string) => {
    setRelationFilter((prev) => {
      if (prev === null) return [type];
      if (prev.includes(type)) {
        const next = prev.filter((t) => t !== type);
        return next.length > 0 ? next : null;
      }
      return [...prev, type];
    });
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-lg">Knowledge graph</h2>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Semantic & consolidated episodic memories linked by associative
            and consolidation relations. Click nodes to inspect details,
            {viewMode === "3d" ? " drag to rotate the globe, scroll to zoom." : " drag to pan, scroll to zoom."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border">
            <button
              aria-pressed={viewMode === "2d"}
              className={`px-2.5 py-1 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex items-center gap-1 ${
                viewMode === "2d"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setViewMode("2d")}
              type="button"
            >
              <GridFour className="size-3.5" />
              2D
            </button>
            <button
              aria-pressed={viewMode === "3d"}
              className={`px-2.5 py-1 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex items-center gap-1 ${
                viewMode === "3d"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setViewMode("3d")}
              type="button"
            >
              <Cube className="size-3.5" />
              3D
            </button>
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
      </div>

      {/* Filter bar: relation-type chips (counts from global stats),
          node-type toggle, and search. All server-applied. */}
      <div className="flex flex-wrap items-center gap-2">
        {graph &&
          Object.entries(graph.stats.byRelationType).map(([type, n]) => {
            const active = relationFilter === null || relationFilter.includes(type);
            return (
              <button
                aria-pressed={active}
                className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                key={type}
                onClick={() => toggleRelation(type)}
                type="button"
              >
                <Badge
                  className="cursor-pointer select-none gap-1.5"
                  variant={active ? "default" : "outline"}
                >
                  {type}
                  <span className={active ? "opacity-70" : "text-muted-foreground"}>
                    {n}
                  </span>
                </Badge>
              </button>
            );
          })}
        <div className="flex rounded-md border">
          {(["all", "semantic", "episodic"] as const).map((t) => (
            <button
              aria-pressed={nodeFilter === t}
              className={`px-2.5 py-1 text-xs capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                nodeFilter === t
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              key={t}
              onClick={() => setNodeFilter(t)}
              type="button"
            >
              {t === "all" ? "All types" : t}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-56">
          <MagnifyingGlass className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 pl-8 pr-7 text-xs"
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search labels & tags…"
            type="search"
            value={searchInput}
          />
          {searchInput && (
            <button
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
              onClick={() => setSearchInput("")}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {filteredOut && (
          <Button
            onClick={() => {
              setRelationFilter(null);
              setNodeFilter("all");
              setSearchInput("");
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Reset filters
          </Button>
        )}
      </div>

      {graph && graph.nodes.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
          <div className="overflow-hidden rounded-lg border bg-background">
            <div className="overflow-hidden rounded-lg border bg-background relative h-[600px]">
              {viewMode === "3d" ? (
                <KnowledgeGraphGlobe
                  graph={graph}
                  selectedNodeId={selectedNode}
                  onSelectNode={(id) => setSelectedNode(id)}
                />
              ) : (
                <KnowledgeGraph2D
                  graph={graph}
                  selectedNodeId={selectedNode}
                  onSelectNode={(id) => setSelectedNode(id)}
                />
              )}
            </div>
          </div>
          <div className="space-y-1.5 text-sm">
            {/* Pinned node detail replaces hover-only labels. */}
            {selected ? (
              <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium break-words text-sm">
                    {selected.label}
                  </p>
                  <button
                    aria-label="Close details"
                    className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    onClick={() => setSelectedNode(null)}
                    type="button"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <StatRow label="Type" value={selected.type} />
                <StatRow label="Importance" value={selected.importance.toFixed(2)} />
                <StatRow label="Links" value={String(selected.degree)} />
                <StatRow label="Accessed" value={String(selected.accessCount)} />
                <StatRow label="Created" value={formatTimestamp(selected.createdAt)} />
                {selected.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {selected.tags.slice(0, 8).map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <StatRow label="Semantic nodes" value={String(graph.stats.semanticCount)} />
                <StatRow label="Episodic nodes" value={String(graph.stats.episodicCount)} />
                <StatRow label="Relations" value={String(graph.stats.relationCount)} />
                {Object.entries(graph.stats.byRelationType).map(([type, n]) => (
                  <StatRow key={type} label={`· ${type}`} value={String(n)} />
                ))}
                {graph.stats.topTags.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-2">
                    {graph.stats.topTags.map(({ tag, count }) => (
                      <Badge
                        className="cursor-pointer"
                        key={tag}
                        onClick={() => setSearchInput(tag)}
                        variant="outline"
                      >
                        {tag}
                        <span className="text-muted-foreground">{count}</span>
                      </Badge>
                    ))}
                  </div>
                )}
              </>
            )}
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
            search ? (
              <p className="max-w-md text-muted-foreground text-sm">
                No memories match “{search}”. Try a shorter query or reset
                the filters.
              </p>
            ) : (
              <p className="max-w-md text-muted-foreground text-sm">
                No linked memories yet. Knowledge appears here once the dream
                cycle and consolidation link memories together.
              </p>
            )
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


