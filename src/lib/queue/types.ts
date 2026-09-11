export type JobType =
  | "ingest_turn"
  | "reflect_turn"
  | "sleep_consolidation"
  | "dream_graph_discovery"
  | "decay_sweep"
  | "scheduled_reminder"
  | "proactive_event_check";

export type JobStatus = "pending" | "processing" | "completed" | "failed";

export type JobPayload = Record<string, unknown>;

export interface JobRow {
  id: string;
  type: JobType;
  payload: JobPayload;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lockedAt: Date | null;
  runAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueJobInput {
  id?: string;
  type: JobType;
  payload: JobPayload;
  runAt?: Date;
  maxAttempts?: number;
}
