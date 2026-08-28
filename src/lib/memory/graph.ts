import { desc, isNotNull } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { episodicMemories, memoryRelations, semanticMemories } from "@/db/schema";

/**
 * Knowledge graph extraction for the Statistics page: semantic and
 * episodic memories as nodes, `memory_relations` rows as edges. The
 * result is capped so the client-side force layout stays responsive;
 * the highest-degree / highest-importance nodes are kept first.
 */

export interface GraphNode {
  id: string;
  label: string;
  type: "semantic" | "episodic";
  importance: number;
  degree: number;
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
  };
}

const LABEL_CHARS = 60;
const DEFAULT_MAX_NODES = 150;

function makeLabel(content: string | null | undefined): string {
  const clean = (content ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "untitled";
  if (clean.length <= LABEL_CHARS) return clean;
  return `${clean.slice(0, LABEL_CHARS)}…`;
}

export async function getKnowledgeGraph(
  options: { maxNodes?: number; db?: AppDatabase } = {}
): Promise<KnowledgeGraph> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const db = options.db ?? defaultDb;

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
      })
      .from(semanticMemories)
      .orderBy(desc(semanticMemories.importance))
      .limit(1000),
    db
      .select({
        id: episodicMemories.id,
        content: episodicMemories.content,
        importance: episodicMemories.importance,
      })
      .from(episodicMemories)
      .where(isNotNull(episodicMemories.consolidatedInto))
      .orderBy(desc(episodicMemories.importance))
      .limit(500),
  ]);

  const nodeMeta = new Map<
    string,
    { label: string; type: GraphNode["type"]; importance: number }
  >();
  for (const row of semanticRows) {
    nodeMeta.set(row.id, {
      label: makeLabel(row.content),
      type: "semantic",
      importance: row.importance ?? 0.5,
    });
  }
  for (const row of episodicRows) {
    nodeMeta.set(row.id, {
      label: makeLabel(row.content),
      type: "episodic",
      importance: row.importance ?? 0.5,
    });
  }

  // Degree counts drive which nodes survive the cap.
  const degree = new Map<string, number>();
  const byRelationType: Record<string, number> = {};
  for (const rel of relations) {
    // Only count degrees for relations whose endpoints are known
    if (nodeMeta.has(rel.fromMemoryId) && nodeMeta.has(rel.toMemoryId)) {
      degree.set(rel.fromMemoryId, (degree.get(rel.fromMemoryId) ?? 0) + 1);
      degree.set(rel.toMemoryId, (degree.get(rel.toMemoryId) ?? 0) + 1);
      byRelationType[rel.relationType] = (byRelationType[rel.relationType] ?? 0) + 1;
    }
  }

  // Candidate nodes: everything connected, then isolated semantic memories
  // by importance so the graph still shows knowledge when links are sparse.
  const candidates: GraphNode[] = [];
  const seen = new Set<string>();
  for (const id of degree.keys()) {
    const meta = nodeMeta.get(id);
    if (!meta || seen.has(id)) continue;
    seen.add(id);
    candidates.push({ id, ...meta, degree: degree.get(id) ?? 0 });
  }
  for (const row of semanticRows) {
    if (candidates.length >= maxNodes * 2) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    candidates.push({
      id: row.id,
      label: makeLabel(row.content),
      type: "semantic",
      importance: row.importance ?? 0.5,
      degree: 0,
    });
  }

  candidates.sort(
    (a, b) =>
      b.degree - a.degree || (b.importance ?? 0) - (a.importance ?? 0)
  );
  const nodes = candidates.slice(0, maxNodes);
  const keptIds = new Set(nodes.map((n) => n.id));

  const edges: GraphEdge[] = relations
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
    },
  };
}
