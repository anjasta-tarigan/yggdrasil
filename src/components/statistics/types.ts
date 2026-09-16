/**
 * Shared client-side types for the Statistics page. The API routes are
 * the source of truth; these shapes mirror their JSON payloads
 * (see src/app/api/system/*). One module keeps the three tabs and the
 * parent shell type-aligned, mirroring components/skills/types.ts.
 */

export type SystemStats = {
  collectedAt: string;
  device: {
    hostname: string;
    platform: string;
    arch: string;
    osRelease: string;
    cpuModel: string;
    cpuCores: number;
    nodeVersion: string;
    nextVersion: string | null;
    processUptimeSeconds: number;
  };
  resources: {
    loadAverage: [number, number, number];
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    /** Real available memory (MemAvailable on Linux, or os.freemem fallback on Windows/macOS). */
    memoryAvailableBytes?: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
    processHeapTotalBytes: number;
    diskTotalBytes: number;
    diskFreeBytes: number;
    databaseSizeBytes: number;
  };
  gpu: {
    name: string;
    memoryUsedMb: number;
    memoryTotalMb: number;
    utilizationPercent: number;
  } | null;
  services: {
    llm: {
      baseUrl: string | null;
      modelId: string | null;
      status: "ok" | "down" | "unconfigured";
      latencyMs: number | null;
    };
    embedding: {
      provider: string;
      baseUrl: string | null;
      model: string | null;
      loaded?: boolean;
      modelPath?: string | null;
    };
    reranker?: {
      enabled: boolean;
      status: "active" | "standby" | "fallback" | "disabled";
      model: string | null;
      loaded: boolean;
      modelPath: string | null;
      sizeBytes?: number;
    };
  };
  scheduler: {
    daemonRunning: boolean;
    queueRunnerRunning: boolean;
    cron: Record<string, string>;
  };
  database: {
    chatCount: number;
    messageCount: number;
    memories: { episodic: number; semantic: number; working: number };
    queue: { pending: number; completed: number; failed: number };
    cognitive?: {
      daemonRunning: boolean;
      queueRunnerRunning: boolean;
      relations: number;
      unembedded: { episodic: number; semantic: number };
      lastRuns: Array<{ type: string; at: string | null }>;
      lastFailure: { type: string; error: string | null; at: string | null } | null;
    };
  };
};

export type GraphNode = {
  id: string;
  label: string;
  type: "semantic" | "episodic";
  importance: number;
  degree: number;
  tags: string[];
  accessCount: number;
  createdAt: number | null;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: Array<{
    source: string;
    target: string;
    relationType: string;
    strength: number;
  }>;
  truncated: boolean;
  stats: {
    semanticCount: number;
    episodicCount: number;
    relationCount: number;
    byRelationType: Record<string, number>;
    topHubs: Array<{ id: string; label: string; degree: number }>;
    topTags: Array<{ tag: string; count: number }>;
  };
};

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
};
