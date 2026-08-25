export type MemoryType = "working" | "episodic" | "semantic";

export type WorkingMemoryInput = {
  content: string;
  tags?: string[];
  ttlSeconds?: number;
  embedding?: Float32Array;
};

export type EpisodicMemoryInput = {
  sessionId?: string;
  content: string;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  embedding?: Float32Array;
};

export type SemanticMemoryInput = {
  content: string;
  importance?: number;
  tags?: string[];
  sources?: string[];
  metadata?: Record<string, unknown>;
  embedding?: Float32Array;
};

export type MemoryRelationInput = {
  fromMemoryId: string;
  fromMemoryType: MemoryType;
  toMemoryId: string;
  toMemoryType: MemoryType;
  relationType: string;
  strength?: number;
};
