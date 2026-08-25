import { nanoid } from "nanoid";
import { isNotNull } from "drizzle-orm";
import { db as defaultDb, type AppDatabase } from "@/db";
import { semanticMemories, memoryRelations } from "@/db/schema";
import { bufferToVector, cosineSimilarity } from "./embeddings";

export type DreamOptions = {
  similarityThreshold?: number;
  maxNeighborsPerNode?: number;
  db?: AppDatabase;
};

export async function runDreamGraphDiscovery(options: DreamOptions = {}) {
  const similarityThreshold = options.similarityThreshold ?? 0.82;
  const maxNeighborsPerNode = options.maxNeighborsPerNode ?? 3;
  const db = options.db ?? defaultDb;

  // 1. Scan semantic memories with non-null embeddings
  const nodes = await db
    .select({
      id: semanticMemories.id,
      embedding: semanticMemories.embedding,
    })
    .from(semanticMemories)
    .where(isNotNull(semanticMemories.embedding));

  if (nodes.length < 2) {
    return { edgesCreated: 0 };
  }

  // Parse embeddings
  const parsedNodes = nodes
    .filter((n): n is { id: string; embedding: Buffer } => n.embedding !== null)
    .map((n) => ({
      id: n.id,
      vector: bufferToVector(n.embedding),
    }));

  let edgesCreated = 0;

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

  // 1. Perform CPU-heavy pairwise cosine calculations outside the SQLite write lock
  const plannedEdges: Array<{ fromId: string; toId: string; similarity: number }> = [];

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
    const topNeighbors = candidates.slice(0, maxNeighborsPerNode);

    for (const neighbor of topNeighbors) {
      const forwardKey = `${source.id}->${neighbor.targetId}:associative_link`;
      if (!relationSet.has(forwardKey)) {
        plannedEdges.push({
          fromId: source.id,
          toId: neighbor.targetId,
          similarity: Number(neighbor.similarity.toFixed(4)),
        });
        relationSet.add(forwardKey);
      }
    }
  }

  if (plannedEdges.length === 0) {
    return { edgesCreated: 0 };
  }

  // 2. Fast synchronous batch write inside transaction without CPU holding lock
  db.transaction((tx) => {
    for (const edge of plannedEdges) {
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
  };
}
