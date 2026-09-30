// src/lib/llama/types.ts
/** Error for fail-fast GGUF resource planning/startup failures. Message is user-facing. */
export class LlamaResourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlamaResourceError";
  }
}

export const DEFAULT_GGUF_PORT = 2301;
export const GGUF_MODELS_DIRNAME = "GGUF-chatModel";
export const GGUF_PIDFILE = ".llama-server.pid";
export const MIN_LLAMA_SERVER_BUILD = 6000;
export const MODEL_DEFAULT_CTX = 8192;
/** Health-poll interval while waiting for a fresh spawn to become ready. */
export const HEALTH_POLL_MS = 500;
/** First-load grace period for large models before a spawn is declared failed. */
export const SPAWN_TIMEOUT_MS = 60_000;
/** SIGTERM grace period before SIGKILL on idle shutdown / app exit. */
export const SIGTERM_GRACE_MS = 10_000;

export const GB = (n: number): number => Math.floor(n * 1024 ** 3);
export const MB = (n: number): number => Math.floor(n * 1024 ** 2);

export interface DeviceProfile {
  cpuCores: number;
  totalMemBytes: number;
  freeMemBytes: number;
}

export type KvDtype = "f16" | "q8_0";

export interface GgufOverrides {
  contextWindow?: number;
  kvDtype?: "auto" | KvDtype;
  ngl?: number;
  extraFlags?: string[];
  idleMinutes?: number;
}

export interface PlanInput {
  filename: string;
  modelSizeBytes: number;
  /** Model's advertised context cap (capabilities.contextWindow); null when unknown. */
  modelCtxCap: number | null;
  profile: DeviceProfile;
  overrides?: GgufOverrides;
}

export interface PlannedServer {
  args: string[];
  ctx: number;
  kvDtype: KvDtype;
  threads: number;
  batchSize: number;
  ubatchSize: number;
  port: number;
  contextShrunk: boolean;
  shrinkReason: string | null;
  unparsedParams: boolean;
  idleMinutes: number;
}

export interface GgufFileEntry {
  filename: string;
  path: string;
  sizeBytes: number;
  fitsMemory: boolean;
}

export interface LlamaServerInfo {
  path: string;
  /** Parsed build number; null when --version output is unrecognized (warn-and-proceed). */
  version: number | null;
}

export type GgufRunnerState = "running" | "standby" | "unload";

export interface RunnerStatus {
  state: GgufRunnerState;
  pid: number | null;
  planned: PlannedServer | null;
  lastError: string | null;
}
