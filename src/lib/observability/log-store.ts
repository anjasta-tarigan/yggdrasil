import fs from "node:fs";
import path from "node:path";

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
/** Overridable for tests; defaults to the app's data directory. */
const LOG_DIR = process.env.YGGDRASIL_LOG_DIR
  ? path.resolve(process.env.YGGDRASIL_LOG_DIR)
  : path.resolve(process.cwd(), "data/logs");
const LOG_FILE = path.join(LOG_DIR, "yggdrasil.log");
const ROTATED_FILE = path.join(LOG_DIR, "yggdrasil.log.1");

type LogStoreState = {
  buffer: LogEntry[];
  nextId: number;
  fileBytes: number;
  fileReady: boolean;
};

const LOG_GLOBAL_KEY = "__yggdrasilLogStore";

function storeState(): LogStoreState {
  const g = globalThis as unknown as Record<string, LogStoreState | undefined>;
  if (!g[LOG_GLOBAL_KEY]) {
    let fileBytes = 0;
    try {
      fileBytes = fs.statSync(LOG_FILE).size;
    } catch {
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
    fs.mkdirSync(LOG_DIR, { recursive: true });
    state.fileReady = true;
  } catch {
    // Directory not creatable — file mirroring stays disabled.
  }
}

function rotateIfNeeded(state: LogStoreState): void {
  if (state.fileBytes < FILE_SIZE_CAP_BYTES) return;
  try {
    fs.rmSync(ROTATED_FILE, { force: true });
    fs.renameSync(LOG_FILE, ROTATED_FILE);
    state.fileBytes = 0;
  } catch {
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
    const entry: LogEntry = {
      id: state.nextId++,
      at: new Date().toISOString(),
      level,
      scope,
      message,
    };
    state.buffer.push(entry);
    if (state.buffer.length > RING_CAPACITY) {
      state.buffer.splice(0, state.buffer.length - RING_CAPACITY);
    }

    ensureLogDir(state);
    if (state.fileReady) {
      rotateIfNeeded(state);
      const sanitizedMessage = message.replace(/[\r\n]+/g, " ");
      const line = `${entry.at} [${level.toUpperCase()}] [${scope}] ${sanitizedMessage}\n`;
      fs.appendFileSync(LOG_FILE, line);
      state.fileBytes += Buffer.byteLength(line);
    }
  } catch {
    // Swallow — see above.
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
  } catch {
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
