import fs from "node:fs";
import path from "node:path";
import { env } from "@/env";

/**
 * Structured system log store — the source for the Statistics page log
 * viewer. Events live in an in-memory ring buffer (fast, bounded) and are
 * mirrored to `data/logs/yggdrasil.log` so they survive restarts. The
 * file rotates to `.1` when it exceeds the size cap.
 *
 * Anchored on globalThis so dev-server HMR reloads keep one buffer/file
 * handle instead of fragmenting history across module generations.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: number;
  at: string; // ISO timestamp
  level: LogLevel;
  scope: string;
  message: string;
}

const RING_CAPACITY = 2000;
const FILE_SIZE_CAP_BYTES = 2 * 1024 * 1024;

/** Regex matching ANSI escape sequences (colors, cursor positioning, SGR codes). */
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/** Overridable for tests; defaults to the app's data directory. */
const LOG_DIR = env.YGGDRASIL_LOG_DIR
  ? path.resolve(env.YGGDRASIL_LOG_DIR)
  : path.resolve(process.cwd(), "data/logs");
const LOG_FILE = path.join(LOG_DIR, "yggdrasil.log");
const ROTATED_FILE = path.join(LOG_DIR, "yggdrasil.log.1");

type LogStoreState = {
  buffer: LogEntry[];
  nextId: number;
  fileBytes: number;
  fileReady: boolean;
};

/**
 * Captured at module load to avoid recursion: when capture.ts patches
 * console.error to forward to syslog, a syslog failure would otherwise
 * re-enter itself. This reference lets us fall back to the real stderr.
 */
const originalConsoleError: (...args: unknown[]) => void = console.error.bind(console);

const LOG_GLOBAL_KEY = "__yggdrasilLogStore";

function storeState(): LogStoreState {
  const g = globalThis as unknown as Record<string, LogStoreState | undefined>;
  if (!g[LOG_GLOBAL_KEY]) {
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(/* turbopackIgnore: true */ LOG_FILE).size;
    } catch (err) {
      // Must NOT call syslog() here: the store global is still unset at this
      // point, so syslog -> storeState() would re-enter this block and recurse
      // until the stack overflows. Report via the captured console instead.
      originalConsoleError(
        "[observability] log-store: cannot stat log file:",
        err instanceof Error ? err.message : String(err)
      );
      // No log file yet.
    }
    g[LOG_GLOBAL_KEY] = {
      buffer: [],
      nextId: 1,
      fileBytes,
      fileReady: false,
    };
  }
  return g[LOG_GLOBAL_KEY];
}

function ensureLogDir(state: LogStoreState): void {
  if (state.fileReady) return;
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ LOG_DIR, { recursive: true });
    state.fileReady = true;
  } catch (err) {
    // Called from within syslog(); use the captured console to avoid re-entry.
    originalConsoleError(
      "[observability] log-store: cannot create log dir:",
      err instanceof Error ? err.message : String(err)
    );
    // Directory not creatable — file mirroring stays disabled.
  }
}

function rotateIfNeeded(state: LogStoreState): void {
  if (state.fileBytes < FILE_SIZE_CAP_BYTES) return;
  try {
    fs.rmSync(/* turbopackIgnore: true */ ROTATED_FILE, { force: true });
    fs.renameSync(/* turbopackIgnore: true */ LOG_FILE, ROTATED_FILE);
    state.fileBytes = 0;
  } catch (err) {
    // Called from within syslog(); use the captured console to avoid re-entry.
    originalConsoleError(
      "[observability] log-store: rotation failed:",
      err instanceof Error ? err.message : String(err)
    );
    // Rotation failed — keep appending; better logs than no app.
  }
}

/**
 * Records a structured system event. Never throws: logging must not take
 * down the subsystem doing the logging.
 */
export function syslog(level: LogLevel, scope: string, message: string): void {
  try {
    const state = storeState();
    const cleanMessage = stripAnsi(message);
    const cleanScope = stripAnsi(scope);
    const entry: LogEntry = {
      id: state.nextId++,
      at: new Date().toISOString(),
      level,
      scope: cleanScope,
      message: cleanMessage,
    };
    state.buffer.push(entry);
    if (state.buffer.length > RING_CAPACITY) {
      state.buffer.splice(0, state.buffer.length - RING_CAPACITY);
    }

    ensureLogDir(state);
    if (state.fileReady) {
      rotateIfNeeded(state);
      const sanitizedMessage = cleanMessage.replace(/[\r\n]+/g, " ");
      const line = `${entry.at} [${level.toUpperCase()}] [${cleanScope}] ${sanitizedMessage}\n`;
      fs.appendFileSync(LOG_FILE, line);
      state.fileBytes += Buffer.byteLength(line);
    }
  } catch (error) {
    originalConsoleError(
      "[observability] syslog failed:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export interface LogQuery {
  /** Return at most this many most-recent entries (default 200). */
  limit?: number;
  /** Keep only entries at this level or above. */
  minLevel?: LogLevel;
  /** Case-insensitive substring match on scope or message. */
  search?: string;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function queryLogs(query: LogQuery = {}): LogEntry[] {
  const state = storeState();
  const limit = Math.max(1, Math.min(query.limit ?? 200, RING_CAPACITY));
  const minRank = LEVEL_RANK[query.minLevel ?? "debug"] ?? 0;
  const needle = query.search?.trim().toLowerCase();

  let entries = state.buffer.filter((e) => LEVEL_RANK[e.level] >= minRank);
  if (needle) {
    entries = entries.filter(
      (e) =>
        e.scope.toLowerCase().includes(needle) ||
        e.message.toLowerCase().includes(needle)
    );
  }
  return entries.slice(-limit);
}

export function clearLogs(): number {
  const state = storeState();
  const cleared = state.buffer.length;
  state.buffer = [];
  try {
    ensureLogDir(state);
    if (state.fileReady) {
      fs.rmSync(LOG_FILE, { force: true });
      fs.rmSync(ROTATED_FILE, { force: true });
      state.fileBytes = 0;
    }
  } catch (err) {
    originalConsoleError(
      "[observability] log-store: log cleanup failed:",
      err instanceof Error ? err.message : String(err)
    );
    // File cleanup is best-effort.
  }
  return cleared;
}

/** Full current buffer as plain text (for the download action). */
export function logsAsText(): string {
  const state = storeState();
  return state.buffer
    .map((e) => `${e.at} [${e.level.toUpperCase()}] [${e.scope}] ${e.message}`)
    .join("\n");
}

export function logFilePath(): string {
  return LOG_FILE;
}

/* ─── Agent lifecycle metrics ─────────────────────────────────────────── */

/**
 * Per-call observability metric captured from AI SDK v7 lifecycle callbacks.
 *
 * Each record corresponds to a single lifecycle event within a generation
 * call. Not every field is populated by every callback — e.g. tool-execution
 * events set `toolName`/`durationMs` while leaving token fields null, and
 * model-call events set token/throughput fields while leaving `toolName` null.
 */
export interface AgentMetric {
  /** Unique identifier for the generation call, correlated across callbacks. */
  callId: string;
  /** Zero-based step index the event belongs to (null when not step-scoped). */
  stepNumber: number | null;
  /** Name of the tool being executed (null for non-tool events). */
  toolName: string | null;
  /** Response / execution duration in milliseconds (null when unmeasured). */
  durationMs: number | null;
  /** Input (prompt) tokens reported by the model call. */
  inputTokens: number | null;
  /** Output (completion) tokens reported by the model call. */
  outputTokens: number | null;
  /** Total tokens used by the model call. */
  totalTokens: number | null;
  /** Unified finish reason for the event (null when not applicable). */
  finishReason: string | null;
  /** ISO timestamp at which the metric was recorded. */
  at: string;
}

const DEFAULT_METRIC_RING_CAPACITY = 1000;

/**
 * Ring-buffer capacity for agent metrics. Overridable via the
 * `YGGDRASIL_AGENT_METRIC_CAPACITY` env var (for tests); otherwise a bounded
 * 1000-entry in-memory window (~10-20 full chats of tool-heavy multi-step
 * work) is sufficient for live observability before eviction.
 */
const METRIC_RING_CAPACITY = env.YGGDRASIL_AGENT_METRIC_CAPACITY
  ? Math.max(1, env.YGGDRASIL_AGENT_METRIC_CAPACITY || DEFAULT_METRIC_RING_CAPACITY)
  : DEFAULT_METRIC_RING_CAPACITY;

type MetricStoreState = {
  buffer: AgentMetric[];
};

const METRIC_GLOBAL_KEY = "__yggdrasilAgentMetrics";

function metricState(): MetricStoreState {
  const g = globalThis as unknown as Record<string, MetricStoreState | undefined>;
  if (!g[METRIC_GLOBAL_KEY]) {
    g[METRIC_GLOBAL_KEY] = { buffer: [] };
  }
  return g[METRIC_GLOBAL_KEY];
}

/** Fields a caller may populate on a metric record (callId is required). */
export type AgentMetricInput = Partial<
  Omit<AgentMetric, "callId" | "at">
> & { callId: string };

/**
 * Records an agent-lifecycle metric in the bounded in-memory ring buffer.
 * Mirrors `syslog`'s never-throw contract: a failure here must not propagate
 * into the AI SDK call loop.
 */
export function recordAgentMetric(metric: AgentMetricInput): void {
  try {
    const state = metricState();
    const now = new Date().toISOString();
    const record: AgentMetric = {
      callId: metric.callId,
      stepNumber: metric.stepNumber ?? null,
      toolName: metric.toolName ?? null,
      durationMs: metric.durationMs ?? null,
      inputTokens: metric.inputTokens ?? null,
      outputTokens: metric.outputTokens ?? null,
      totalTokens: metric.totalTokens ?? null,
      finishReason: metric.finishReason ?? null,
      at: now,
    };
    state.buffer.push(record);
    if (state.buffer.length > METRIC_RING_CAPACITY) {
      state.buffer.splice(0, state.buffer.length - METRIC_RING_CAPACITY);
    }
  } catch (error) {
    syslog(
      "error",
      "observability",
      `recordAgentMetric failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Returns recorded metrics, optionally filtered to a single `callId`.
 * Results are ordered newest-last to match `queryLogs`.
 */
export function queryAgentMetrics(callId?: string): AgentMetric[] {
  const state = metricState();
  let records = state.buffer;
  if (callId !== undefined) {
    records = records.filter((m) => m.callId === callId);
  }
  return records.slice();
}

/** Clears all recorded agent metrics. Returns the number removed. */
export function clearAgentMetrics(): number {
  const state = metricState();
  const cleared = state.buffer.length;
  state.buffer = [];
  return cleared;
}
