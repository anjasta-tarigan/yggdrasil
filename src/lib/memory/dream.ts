import { nanoid } from "nanoid";
import { isNotNull, sql } from "drizzle-orm";
import type Database from "better-sqlite3";
import { db as defaultDb, sqlite as defaultSqlite, type AppDatabase } from "@/db";
import { semanticMemories, memoryRelations } from "@/db/schema";
import { bufferToVector, cosineSimilarity } from "./embeddings";
import { syncVectorIndex, vectorKnn } from "./vector-index";

export type DreamOptions = {
  similarityThreshold?: number;
  maxNeighborsPerNode?: number;
  db?: AppDatabase;
  /** Raw better-sqlite3 handle for the sqlite-vec fast path. */
  sqlite?: Database.Database;
};

export interface DreamResult {
  edgesCreated: number;
  /** Which similarity engine ran: sqlite-vec KNN or in-JS pairwise. */
  engine: "vec_knn" | "js_pairwise";
  /** Nodes skipped because their embedding dim differs from the majority. */
  skippedMixedDim: number;
}

type ParsedNode = { id: string; rowid: number; vector: Float32Array };
type PlannedEdge = { fromId: string; toId: string; similarity: number };

/**
 * Dream cycle — discovers associative links between semantic memories.
 *
 * Fast path: when sqlite-vec is loaded, each node is looked up against the
 * `semantic_memories_vec` index with a KNN query (O(N · k) instead of the
 * O(N²) all-pairs scan). The index only holds one dimensionality at a
 * time, so nodes are grouped by vector length and only the largest group
 * is processed per pass (after an embedding-model change the backfill
 * sweep migrates rows to the new dim and the next dream picks them up).
 *
 * Fallback: without the extension the original in-JS pairwise cosine scan
 * runs over all nodes (mixed dims are safe — mismatched lengths score 0).
 */
export async function runDreamGraphDiscovery(options: DreamOptions = {}): Promise<DreamResult> {
  const similarityThreshold = options.similarityThreshold ?? 0.82;
  const maxNeighborsPerNode = options.maxNeighborsPerNode ?? 3;
  const db = options.db ?? defaultDb;
  // If a custom db is passed but options.sqlite is omitted, fall back to defaultSqlite only if db === defaultDb
  const sqlite = options.sqlite ?? (options.db && options.db !== defaultDb ? undefined : defaultSqlite);

  // 1. Scan semantic memories with non-null embeddings (rowid joins to vec index)
  const nodes = await db
    .select({
      id: semanticMemories.id,
      rowid: sql<number>`rowid`,
      embedding: semanticMemories.embedding,
    })
    .from(semanticMemories)
    .where(isNotNull(semanticMemories.embedding));

  if (nodes.length < 2) {
    return { edgesCreated: 0, engine: "js_pairwise", skippedMixedDim: 0 };
  }

  const parsedNodes: ParsedNode[] = nodes
    .filter((n): n is { id: string; rowid: number; embedding: Buffer } => n.embedding !== null)
    .map((n) => ({
      id: n.id,
      rowid: Number(n.rowid),
      vector: bufferToVector(n.embedding),
    }));

  // Fetch all existing relations to prevent duplicates
  const existingRelations = await db
    .select({
      fromMemoryId: memoryRelations.fromMemoryId,
      toMemoryId: memoryRelations.toMemoryId,
      relationType: memoryRelations.relationType,
    })
    .from(memoryRelations);

  const relationSet = new Set<string>();
  for (const rel of existingRelations) {
    relationSet.add(`${rel.fromMemoryId}->${rel.toMemoryId}:${rel.relationType}`);
  }

  // 2. Plan edges outside the SQLite write lock
  const plannedEdges = planEdges(
    parsedNodes,
    sqlite,
    similarityThreshold,
    maxNeighborsPerNode,
    relationSet
  );

  if (plannedEdges.edges.length === 0) {
    return {
      edgesCreated: 0,
      engine: plannedEdges.engine,
      skippedMixedDim: plannedEdges.skippedMixedDim,
    };
  }

  // 3. Fast synchronous batch write inside transaction without CPU holding lock
  let edgesCreated = 0;
  db.transaction((tx) => {
    for (const edge of plannedEdges.edges) {
      tx.insert(memoryRelations).values({
        id: `rel_${nanoid(12)}`,
        fromMemoryId: edge.fromId,
        fromMemoryType: "semantic",
        toMemoryId: edge.toId,
        toMemoryType: "semantic",
        relationType: "associative_link",
        strength: edge.similarity,
      }).run();
      edgesCreated++;
    }
  });

  return {
    edgesCreated,
    engine: plannedEdges.engine,
    skippedMixedDim: plannedEdges.skippedMixedDim,
  };
}

function planEdges(
  parsedNodes: ParsedNode[],
  sqlite: Database.Database | undefined,
  similarityThreshold: number,
  maxNeighborsPerNode: number,
  relationSet: Set<string>
): { edges: PlannedEdge[]; engine: DreamResult["engine"]; skippedMixedDim: number } {
  // Group by embedding dimension — the vec index holds one dim at a time.
  const byDim = new Map<number, ParsedNode[]>();
  for (const node of parsedNodes) {
    const group = byDim.get(node.vector.length);
    if (group) group.push(node);
    else byDim.set(node.vector.length, [node]);
  }

  let largestDim = 0;
  let largestGroup: ParsedNode[] = [];
  for (const [dim, group] of byDim) {
    if (group.length > largestGroup.length) {
      largestDim = dim;
      largestGroup = group;
    }
  }

  const vecUsable =
    !!sqlite &&
    largestGroup.length >= 2 &&
    syncVectorIndex(sqlite, "semantic", largestDim);

  if (vecUsable && sqlite) {
    return {
      edges: planEdgesWithVecIndex(
        largestGroup,
        sqlite,
        similarityThreshold,
        maxNeighborsPerNode,
        relationSet
      ),
      engine: "vec_knn",
      skippedMixedDim: parsedNodes.length - largestGroup.length,
    };
  }

  return {
    edges: planEdgesPairwise(
      parsedNodes,
      similarityThreshold,
      maxNeighborsPerNode,
      relationSet
    ),
    engine: "js_pairwise",
    skippedMixedDim: 0,
  };
}

function planEdgesWithVecIndex(
  group: ParsedNode[],
  sqlite: Database.Database,
  similarityThreshold: number,
  maxNeighborsPerNode: number,
  relationSet: Set<string>
): PlannedEdge[] {
  const rowidToId = new Map<number, string>();
  for (const node of group) rowidToId.set(node.rowid, node.id);

  const edges: PlannedEdge[] = [];
  for (const source of group) {
    // +1 so the node's own row can be excluded without losing a neighbor
    const hits = vectorKnn(sqlite, "semantic", source.vector, maxNeighborsPerNode + 1);
    const candidates: Array<{ targetId: string; similarity: number }> = [];
    for (const hit of hits) {
      const targetId = rowidToId.get(hit.rowid);
      if (!targetId || targetId === source.id) continue;
      const similarity = 1 - hit.distance;
      if (similarity >= similarityThreshold) {
        candidates.push({ targetId, similarity });
      }
    }

    candidates.sort((a, b) => b.similarity - a.similarity);
    for (const neighbor of candidates.slice(0, maxNeighborsPerNode)) {
      const forwardKey = `${source.id}->${neighbor.targetId}:associative_link`;
      const reverseKey = `${neighbor.targetId}->${source.id}:associative_link`;
      if (!relationSet.has(forwardKey) && !relationSet.has(reverseKey)) {
        edges.push({
          fromId: source.id,
          toId: neighbor.targetId,
          similarity: Number(neighbor.similarity.toFixed(4)),
        });
        relationSet.add(forwardKey);
        relationSet.add(reverseKey);
      }
    }
  }
  return edges;
}

function planEdgesPairwise(
  parsedNodes: ParsedNode[],
  similarityThreshold: number,
  maxNeighborsPerNode: number,
  relationSet: Set<string>
): PlannedEdge[] {
  const edges: PlannedEdge[] = [];

  for (let i = 0; i < parsedNodes.length; i++) {
    const source = parsedNodes[i];
    const candidates: Array<{ targetId: string; similarity: number }> = [];

    for (let j = 0; j < parsedNodes.length; j++) {
      if (i === j) continue;
      const target = parsedNodes[j];
      const similarity = cosineSimilarity(source.vector, target.vector);
      if (similarity >= similarityThreshold) {
        candidates.push({ targetId: target.id, similarity });
      }
    }

    // Sort descending by similarity and take top-N
    candidates.sort((a, b) => b.similarity - a.similarity);
    for (const neighbor of candidates.slice(0, maxNeighborsPerNode)) {
      const forwardKey = `${source.id}->${neighbor.targetId}:associative_link`;
      const reverseKey = `${neighbor.targetId}->${source.id}:associative_link`;
      if (!relationSet.has(forwardKey) && !relationSet.has(reverseKey)) {
        edges.push({
          fromId: source.id,
          toId: neighbor.targetId,
          similarity: Number(neighbor.similarity.toFixed(4)),
        });
        relationSet.add(forwardKey);
        relationSet.add(reverseKey);
      }
    }
  }
  return edges;
}
