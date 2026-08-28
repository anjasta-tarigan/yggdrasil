export type MemoryType = "working" | "episodic" | "semantic";

export type WorkingMemoryInput = {
  content: string;
  tags?: string[];
  ttlSeconds?: number;
  /** Null when the embedding endpoint was unavailable at write time. */
  embedding?: Float32Array | null;
};

export type EpisodicMemoryInput = {
  sessionId?: string;
  content: string;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Null when the embedding endpoint was unavailable at write time. */
  embedding?: Float32Array | null;
};

export type SemanticMemoryInput = {
  content: string;
  importance?: number;
  tags?: string[];
  sources?: string[];
  metadata?: Record<string, unknown>;
  /** Null when the embedding endpoint was unavailable at write time. */
  embedding?: Float32Array | null;
};

export type MemoryRelationInput = {
  fromMemoryId: string;
  fromMemoryType: MemoryType;
  toMemoryId: string;
  toMemoryType: MemoryType;
  relationType: string;
  strength?: number;
};
