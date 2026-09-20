/**
 * Type contracts for the Yggdrasil eval harness.
 *
 * These mirror the on-disk ground-truth state and the AI-SDK UI-message
 * stream chunk shapes that the Projects chat route emits over SSE. They are
 * intentionally narrow: only the fields the harness inspects are modeled.
 */

// ── Ground truth (filesystem) ─────────────────────────────────────────

/**
 * A file that the agent is expected to create (or avoid creating) on disk.
 * The harness checks the *actual* filesystem state — not the model's tool
 * result — as the source of truth (Spec §3.1).
 */
export interface GroundTruthFile {
  /** Path relative to the project directory. */
  relativePath: string;
  /** Exact expected file content. */
  content: string;
}

// ── AI-SDK UI-message stream chunks (SSE `data:` payloads) ───────────

export interface StartChunk {
  type: "start";
  messageId?: string;
  messageMetadata?: Record<string, unknown>;
}

export interface StartStepChunk {
  type: "start-step";
}

export interface FinishStepChunk {
  type: "finish-step";
  finishReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  performance?: Record<string, unknown>;
}

export interface TextStartChunk {
  type: "text-start";
  id: string;
}

export interface TextDeltaChunk {
  type: "text-delta";
  id: string;
  delta: string;
}

export interface TextEndChunk {
  type: "text-end";
  id: string;
}

export interface ToolInputStartChunk {
  type: "tool-input-start";
  toolCallId: string;
  toolName: string;
}

export interface ToolInputAvailableChunk {
  type: "tool-input-available";
  toolCallId: string;
  toolName: string;
  input: unknown;
  providerExecuted?: boolean;
}

export interface ToolOutputAvailableChunk {
  type: "tool-output-available";
  toolCallId: string;
  toolName: string;
  output: unknown;
  providerExecuted?: boolean;
}
export interface ToolOutputErrorChunk {
  type: "tool-output-error";
  toolCallId: string;
  toolName: string;
  errorText: string;
}

export interface MessageMetadataChunk {
  type: "message-metadata";
  messageMetadata: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    reasoningEffort?: string;
  };
}

export interface FinishChunk {
  type: "finish";
  finishReason?: string;
  messageMetadata?: Record<string, unknown>;
}

export interface AbortChunk {
  type: "abort";
  reason?: string;
}

export interface ErrorChunk {
  type: "error";
  errorText: string;
}

export type UiMessageChunk =
  | StartChunk
  | StartStepChunk
  | FinishStepChunk
  | TextStartChunk
  | TextDeltaChunk
  | TextEndChunk
  | ToolInputStartChunk
  | ToolInputAvailableChunk
  | ToolOutputAvailableChunk
  | ToolOutputErrorChunk
  | MessageMetadataChunk
  | FinishChunk
  | AbortChunk
  | ErrorChunk;

// ── Normalized model of a tool call + its result ──────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  /** The tool result, if any was observed. */
  output?: unknown;
  /** Set when the tool produced an error result. */
  error?: string;
  /** Whether the provider claims it executed the call. */
  providerExecuted?: boolean;
}

// ── Aggregated metrics for a single chat run ──────────────────────────

export interface RunMetrics {
  /** Number of `start-step` chunks (agentic steps). */
  steps: number;
  /** All tool calls observed, in order. */
  toolCalls: ToolCall[];
  /** Tool calls that produced an error result. */
  erroredToolCalls: ToolCall[];
  /** Whether the stream emitted an `error` or `abort` chunk. */
  hadError: boolean;
  /** The text of the first error/abort chunk, if any. */
  errorText: string | null;
  /** The finish reason from the `finish` chunk, if any. */
  finishReason: string | null;
  /** Total assistant text streamed (text-delta deltas concatenated). */
  totalText: string;
  /** Usage from the most recent `message-metadata` chunk. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  /** Reasoning effort label from the most recent `message-metadata` chunk. */
  reasoningEffort: string | null;
  /**
   * Tool calls that share the same (name, serialized input) — a signal of a
   * retry loop where the agent re-issues an identical call.
   */
  repeatedToolCalls: ToolCall[];
}

// ── Evaluation result ─────────────────────────────────────────────────

export type Verdict = "pass" | "fail" | "error";

export interface EvaluationResult {
  /** The scenario that was evaluated. */
  scenarioId: string;
  /** The outcome. */
  verdict: Verdict;
  /** Human-readable explanation of why. */
  reason: string;
  /** Metrics computed from the transcript (null when no transcript). */
  metrics: RunMetrics | null;
  /** Per-scenario detail flags for debugging. */
  detail: Record<string, unknown>;
}

// ── Scenario definition ───────────────────────────────────────────────

export interface Scenario {
  id: string;
  /** Short human-readable name. */
  name: string;
  /** The prompt sent to the agent as a system/user message. */
  prompt: string;
  /**
   * Files the harness pre-creates in the fixture directory before the agent
   * runs. Absent for scenarios that start empty.
   */
  initialFiles?: GroundTruthFile[];
  /**
   * Files the harness expects to find on disk after a correct run. The judge
   * compares actual disk state against these (Spec §3.1).
   */
  expectedFiles?: GroundTruthFile[];
  /**
   * Optional hand-written SSE transcript for offline/replay evaluation. When
   * present, the harness runs the judges against the transcript instead of
   * hitting a live server.
   */
  transcript?: string;
  /**
   * The judge inspects ground-truth disk state plus run metrics and returns
   * a verdict. Ground-truth disk checks take priority over model claims.
   */
  judge: (ctx: {
    metrics: RunMetrics | null;
    fixtureRoot: string;
    expected: GroundTruthFile[];
  }) => Promise<EvaluationResult> | EvaluationResult;
}
