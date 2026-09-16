import { desc, isNotNull } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories, memoryRelations, semanticMemories } from "@/db/schema";

/**
 * Knowledge graph extraction for the Statistics page: semantic and
 * episodic memories as nodes, `memory_relations` rows as edges. The
 * result is capped so the client-side force layout stays responsive;
 * the highest-degree / highest-importance nodes are kept first.
 *
 * Filters (all optional, combined with AND):
 *   relationTypes — keep only these relation types ("associative_link",
 *     "consolidated_into", …). Empty = all.
 *   nodeTypes    — keep only these node types. Empty = all.
 *   search       — case-insensitive substring match on node label or
 *     tags; a node matching pulls in its direct neighbors too, so a
 *     search hit is never an isolated dot.
 */

export interface GraphNode {
  id: string;
  label: string;
  type: "semantic" | "episodic";
  importance: number;
  degree: number;
  tags: string[];
  accessCount: number;
  createdAt: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationType: string;
  strength: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  stats: {
    semanticCount: number;
    episodicCount: number;
    relationCount: number;
    byRelationType: Record<string, number>;
    topHubs: Array<{ id: string; label: string; degree: number }>;
    topTags: Array<{ tag: string; count: number }>;
  };
}

const LABEL_CHARS = 60;
const DEFAULT_MAX_NODES = 150;
const MAX_TOP_TAGS = 12;

export type GraphFilters = {
  relationTypes?: string[];
  nodeTypes?: Array<"semantic" | "episodic">;
  search?: string;
};

function makeLabel(content: string | null | undefined): string {
  const clean = (content ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "untitled";
  if (clean.length <= LABEL_CHARS) return clean;
  return `${clean.slice(0, LABEL_CHARS)}…`;
}

/** JSON-text column → string[], tolerating null/invalid shapes. */
function readTags(raw: unknown): string[] {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((t): t is string => typeof t === "string")
        : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string");
  }
  return [];
}

function countTopTags(nodes: Array<{ tags: string[] }>): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    for (const tag of node.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2) // singletons are noise as facets
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOP_TAGS)
    .map(([tag, count]) => ({ tag, count }));
}

export async function getKnowledgeGraph(
  options: {
    maxNodes?: number;
    db?: AppDatabase;
    filters?: GraphFilters;
  } = {}
): Promise<KnowledgeGraph> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const db = options.db ?? defaultDb;
  const filters = options.filters ?? {};

  const relationTypeSet = new Set(filters.relationTypes ?? []);
  const nodeTypeSet = new Set(filters.nodeTypes ?? []);
  const search = (filters.search ?? "").trim().toLowerCase();

  const [relations, semanticRows, episodicRows] = await Promise.all([
    db
      .select({
        fromMemoryId: memoryRelations.fromMemoryId,
        toMemoryId: memoryRelations.toMemoryId,
        relationType: memoryRelations.relationType,
        strength: memoryRelations.strength,
      })
      .from(memoryRelations)
      .limit(2000),
    db
      .select({
        id: semanticMemories.id,
        content: semanticMemories.content,
        importance: semanticMemories.importance,
        tags: semanticMemories.tags,
        accessCount: semanticMemories.accessCount,
        createdAt: semanticMemories.createdAt,
      })
      .from(semanticMemories)
      .orderBy(desc(semanticMemories.importance))
      .limit(1000),
    db
      .select({
        id: episodicMemories.id,
        content: episodicMemories.content,
        importance: episodicMemories.importance,
        tags: episodicMemories.tags,
        accessCount: episodicMemories.accessCount,
        createdAt: episodicMemories.createdAt,
      })
      .from(episodicMemories)
      .where(isNotNull(episodicMemories.consolidatedInto))
      .orderBy(desc(episodicMemories.importance))
      .limit(500),
  ]);

  // Invalidation bookkeeping (superseded_by) is a backend lifecycle signal, not
  // knowledge. The superseded source is dropped along with the link itself, so
  // the visualization never presents a fact the system already knows is wrong.
  // Stats stay global so the relation-type chips keep showing real counts.
  const invalidationSources = new Set(
    relations
      .filter((rel) => rel.relationType === "superseded_by")
      .map((rel) => rel.fromMemoryId)
  );
  const displayRelations = relations.filter(
    (rel) => rel.relationType !== "superseded_by"
  );

  const nodeMeta = new Map<
    string,
    {
      label: string;
      type: GraphNode["type"];
      importance: number;
      tags: string[];
      accessCount: number;
      createdAt: number | null;
    }
  >();
  for (const row of semanticRows) {
    nodeMeta.set(row.id, {
      label: makeLabel(row.content),
      type: "semantic",
      importance: row.importance ?? 0.5,
      tags: readTags(row.tags),
      accessCount: row.accessCount ?? 0,
      createdAt: row.createdAt != null ? row.createdAt.getTime() : null,
    });
  }
  for (const row of episodicRows) {
    nodeMeta.set(row.id, {
      label: makeLabel(row.content),
      type: "episodic",
      importance: row.importance ?? 0.5,
      tags: readTags(row.tags),
      accessCount: row.accessCount ?? 0,
      createdAt: row.createdAt != null ? row.createdAt.getTime() : null,
    });
  }

  // Relation-type filter (stats stay global; only degrees/edges narrow).
  // Invalidation edges are excluded here too, so a user-supplied
  // relationTypes filter containing "superseded_by" still never renders them.
  const visibleRelations = displayRelations.filter(
    (rel) => relationTypeSet.size === 0 || relationTypeSet.has(rel.relationType)
  );

  // Degree counts drive which nodes survive the cap. Invalidated sources are
  // skipped entirely so they cannot crowd out live memories.
  const degree = new Map<string, number>();
  const byRelationType: Record<string, number> = {};
  for (const rel of visibleRelations) {
    // Only count degrees for relations whose endpoints are known
    if (
      nodeMeta.has(rel.fromMemoryId) &&
      nodeMeta.has(rel.toMemoryId) &&
      !invalidationSources.has(rel.fromMemoryId) &&
      !invalidationSources.has(rel.toMemoryId)
    ) {
      degree.set(rel.fromMemoryId, (degree.get(rel.fromMemoryId) ?? 0) + 1);
      degree.set(rel.toMemoryId, (degree.get(rel.toMemoryId) ?? 0) + 1);
      byRelationType[rel.relationType] =
        (byRelationType[rel.relationType] ?? 0) + 1;
    }
  }

  // Search seed: nodes matching label or tags. Their direct neighbors
  // join the seed set so a hit is shown with its immediate context.
  let searchSeed: Set<string> | null = null;
  if (search) {
    searchSeed = new Set<string>();
    for (const [id, meta] of nodeMeta) {
      if (
        meta.label.toLowerCase().includes(search) ||
        meta.tags.some((t) => t.toLowerCase().includes(search))
      ) {
        searchSeed.add(id);
      }
    }
    for (const rel of visibleRelations) {
      if (searchSeed.has(rel.fromMemoryId)) searchSeed.add(rel.toMemoryId);
      if (searchSeed.has(rel.toMemoryId)) searchSeed.add(rel.fromMemoryId);
    }
    if (searchSeed.size === 0) {
      // No hit anywhere: return an empty graph (the UI shows a no-match
      // state) rather than the unfiltered top-150.
      return {
        nodes: [],
        edges: [],
        truncated: false,
        stats: {
          semanticCount: semanticRows.length,
          episodicCount: episodicRows.length,
          relationCount: relations.length,
          byRelationType: allRelationTypeCounts(relations),
          topHubs: [],
          topTags: countTopTags(
            [...nodeMeta.values()].map((m) => ({ tags: m.tags }))
          ),
        },
      };
    }
  }

  const inScope = (id: string, type: GraphNode["type"]): boolean => {
    if (invalidationSources.has(id)) return false;
    if (nodeTypeSet.size > 0 && !nodeTypeSet.has(type)) return false;
    if (searchSeed && !searchSeed.has(id)) return false;
    return true;
  };

  // Candidate nodes: everything connected, then isolated semantic memories
  // by importance so the graph still shows knowledge when links are sparse.
  const candidates: GraphNode[] = [];
  const seen = new Set<string>();
  for (const id of degree.keys()) {
    const meta = nodeMeta.get(id);
    if (!meta || seen.has(id)) continue;
    if (!inScope(id, meta.type)) continue;
    seen.add(id);
    candidates.push({ id, ...meta, degree: degree.get(id) ?? 0 });
  }
  for (const row of semanticRows) {
    if (candidates.length >= maxNodes * 2) break;
    if (seen.has(row.id)) continue;
    const meta = nodeMeta.get(row.id);
    if (!meta || !inScope(row.id, meta.type)) continue;
    seen.add(row.id);
    candidates.push({ id: row.id, ...meta, degree: 0 });
  }

  candidates.sort(
    (a, b) =>
      b.degree - a.degree || (b.importance ?? 0) - (a.importance ?? 0)
  );
  const nodes = candidates.slice(0, maxNodes);
  const keptIds = new Set(nodes.map((n) => n.id));

  const edges: GraphEdge[] = visibleRelations
    .filter(
      (rel) =>
        rel.fromMemoryId !== rel.toMemoryId &&
        keptIds.has(rel.fromMemoryId) &&
        keptIds.has(rel.toMemoryId)
    )
    .map((rel) => ({
      source: rel.fromMemoryId,
      target: rel.toMemoryId,
      relationType: rel.relationType,
      strength: Number.isFinite(rel.strength) ? rel.strength : 0.5,
    }));

  const topHubs = [...nodes]
    .filter((n) => n.degree > 0)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 5)
    .map((n) => ({ id: n.id, label: n.label, degree: n.degree }));

  return {
    nodes,
    edges,
    truncated: candidates.length > nodes.length,
    stats: {
      semanticCount: semanticRows.length,
      episodicCount: episodicRows.length,
      relationCount: relations.length,
      byRelationType,
      topHubs,
      topTags: countTopTags(nodes),
    },
  };
}

/** Global relation-type counts for filter chips, unaffected by filters. */
function allRelationTypeCounts(
  relations: Array<{ relationType: string }>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rel of relations) {
    counts[rel.relationType] = (counts[rel.relationType] ?? 0) + 1;
  }
  return counts;
}
