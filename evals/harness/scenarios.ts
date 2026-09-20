/**
 * Eval scenarios for the Yggdrasil agentic harness.
 *
 * Each scenario pairs a prompt with:
 *  - expected ground-truth files on disk (the judge's primary signal), and
 *  - a judge that inspects on-disk state + run metrics.
 *
 * Ground truth lives on the filesystem, not in the model's tool results
 * (Spec §3.1). A transcript is attached to each scenario so the judges can be
 * exercised offline; when run live, the transcript is replaced by the real
 * SSE stream captured from the server.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Scenario, GroundTruthFile } from "./contracts";
import {
  TRANSCRIPT_AGENTIC_SUCCESS,
  TRANSCRIPT_CHAT_FAILURE,
  TRANSCRIPT_STREAM_ERROR,
  TRANSCRIPT_RETRY_LOOP,
  TRANSCRIPT_MULTI_STEP_SUCCESS,
  TRANSCRIPT_WRONG_CONTENT,
} from "./transcripts";

/** The marker file every agentic scenario writes. */
const MARKER: GroundTruthFile = {
  relativePath: "marker.txt",
  content: "hello",
};

const NOTE_FILE: GroundTruthFile = {
  relativePath: "note.txt",
  content: "ready",
};

/**
 * Checks that a set of expected files exists on disk with exactly the right
 * content. Returns `{ ok, missing, mismatch }` for detailed diagnostics.
 */
async function checkGroundTruth(
  fixtureRoot: string,
  expected: GroundTruthFile[]
): Promise<{
  ok: boolean;
  missing: string[];
  mismatch: string[];
}> {
  const missing: string[] = [];
  const mismatch: string[] = [];
  for (const file of expected) {
    const abs = path.join(fixtureRoot, file.relativePath);
    let actual: string;
    try {
      actual = await fs.readFile(abs, "utf8");
    } catch {
      missing.push(file.relativePath);
      continue;
    }
    if (actual !== file.content) {
      mismatch.push(
        `${file.relativePath}: expected ${JSON.stringify(file.content)}, got ${JSON.stringify(actual)}`
      );
    }
  }
  return { ok: missing.length === 0 && mismatch.length === 0, missing, mismatch };
}

/** S0 — the agent must write marker.txt containing "hello". */
export const SCENARIO_AGENTIC_SUCCESS: Scenario = {
  id: "S0",
  name: "agentic-success",
  prompt: 'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  transcript: TRANSCRIPT_AGENTIC_SUCCESS,
  judge: async ({ fixtureRoot, expected }) => {
    const gt = await checkGroundTruth(fixtureRoot, expected);
    if (!gt.ok) {
      return {
        scenarioId: "S0",
        verdict: "fail",
        reason: `Ground-truth check failed: missing [${gt.missing.join(", ") || "none"}], mismatched [${gt.mismatch.join(", ") || "none"}]`,
        metrics: null,
        detail: { ...gt },
      };
    }
    return {
      scenarioId: "S0",
      verdict: "pass",
      reason: "marker.txt exists on disk with content 'hello'.",
      metrics: null,
      detail: { ...gt },
    };
  },
};

/** S1 — a chat-only agent that never writes the file should fail. */
export const SCENARIO_CHAT_FAILURE: Scenario = {
  id: "S1",
  name: "chat-like-failure",
  prompt: 'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  transcript: TRANSCRIPT_CHAT_FAILURE,
  judge: async ({ metrics, fixtureRoot, expected }) => {
    const gt = await checkGroundTruth(fixtureRoot, expected);
    const toolCallCount = metrics?.toolCalls.length ?? 0;
    if (gt.ok) {
      // File exists despite no tool calls — unexpected; fail to surface the
      // inconsistency rather than silently passing.
      return {
        scenarioId: "S1",
        verdict: "fail",
        reason:
          "File present on disk but the transcript shows no tool calls — ground truth and model behavior disagree.",
        metrics,
        detail: { toolCallCount, ...gt },
      };
    }
    if (toolCallCount > 0) {
      return {
        scenarioId: "S1",
        verdict: "fail",
        reason: `Agent made ${toolCallCount} tool call(s) but the file is still missing — partial progress without completion.`,
        metrics,
        detail: { toolCallCount, ...gt },
      };
    }
    return {
      scenarioId: "S1",
      verdict: "fail",
      reason: "No file written and no tool calls made — chat-only behavior cannot complete the task.",
      metrics,
      detail: { toolCallCount, ...gt },
    };
  },
};

/** S2 — a stream error (timeout) must be detected as a failure. */
export const SCENARIO_STREAM_ERROR: Scenario = {
  id: "S2",
  name: "stream-error",
  prompt: 'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  transcript: TRANSCRIPT_STREAM_ERROR,
  judge: async ({ metrics, fixtureRoot, expected }) => {
    const gt = await checkGroundTruth(fixtureRoot, expected);
    if (metrics && metrics.hadError) {
      return {
        scenarioId: "S2",
        verdict: "fail",
        reason: `Stream error detected: ${metrics.errorText ?? "unknown error"}`,
        metrics,
        detail: { errorText: metrics.errorText, ...gt },
      };
    }
    // No error in the transcript but file missing — still a failure.
    if (!gt.ok) {
      return {
        scenarioId: "S2",
        verdict: "fail",
        reason: `No stream error but ground truth failed: missing [${gt.missing.join(", ")}], mismatch [${gt.mismatch.join(", ")}]`,
        metrics,
        detail: { ...gt },
      };
    }
    return {
      scenarioId: "S2",
      verdict: "pass",
      reason: "No stream error and file written correctly.",
      metrics,
      detail: { ...gt },
    };
  },
};

/**
 * S3 — a retry loop (identical tool calls re-issued) must be detected as a
 * failure, even if the file was eventually written.
 */
export const SCENARIO_RETRY_LOOP: Scenario = {
  id: "S3",
  name: "retry-loop",
  prompt: 'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  transcript: TRANSCRIPT_RETRY_LOOP,
  judge: async ({ metrics, fixtureRoot, expected }) => {
    const gt = await checkGroundTruth(fixtureRoot, expected);
    if (metrics && metrics.repeatedToolCalls.length > 0) {
      return {
        scenarioId: "S3",
        verdict: "fail",
        reason: `Retry loop detected: ${metrics.repeatedToolCalls.length} duplicate tool call(s) re-issued with identical input.`,
        metrics,
        detail: { repeatedCount: metrics.repeatedToolCalls.length, ...gt },
      };
    }
    // No retry loop but file missing — fail on ground truth.
    if (!gt.ok) {
      return {
        scenarioId: "S3",
        verdict: "fail",
        reason: `No retry loop detected but ground truth failed: missing [${gt.missing.join(", ")}], mismatch [${gt.mismatch.join(", ")}]`,
        metrics,
        detail: { ...gt },
      };
    }
    return {
      scenarioId: "S3",
      verdict: "pass",
      reason: "No retry loop and file written correctly.",
      metrics,
      detail: { ...gt },
    };
  },
};

/** S4 — multi-step agentic: read note.txt, then write marker.txt. */
export const SCENARIO_MULTI_STEP: Scenario = {
  id: "S4",
  name: "multi-step-agentic",
  prompt:
    'First read "note.txt", then using the file_operations tool write a file named "marker.txt" containing exactly "hello".',
  initialFiles: [NOTE_FILE],
  expectedFiles: [MARKER],
  transcript: TRANSCRIPT_MULTI_STEP_SUCCESS,
  judge: async ({ metrics, fixtureRoot, expected }) => {
    const gt = await checkGroundTruth(fixtureRoot, expected);
    if (!gt.ok) {
      return {
        scenarioId: "S4",
        verdict: "fail",
        reason: `Ground-truth check failed: missing [${gt.missing.join(", ") || "none"}], mismatched [${gt.mismatch.join(", ") || "none"}]`,
        metrics,
        detail: { ...gt },
      };
    }
    // Require at least 2 steps (read then write) and at least one read call.
    const hasRead = (metrics?.toolCalls ?? []).some(
      (c) => c.name === "file_operations" && (c.input as { action?: string })?.action === "read"
    );
    if (!hasRead) {
      return {
        scenarioId: "S4",
        verdict: "fail",
        reason: "File written correctly but no read tool call was observed — expected a read-then-write flow.",
        metrics,
        detail: { ...gt, hasRead: false },
      };
    }
    return {
      scenarioId: "S4",
      verdict: "pass",
      reason: "Multi-step flow completed: note.txt read, marker.txt written with 'hello'.",
      metrics,
      detail: { ...gt, hasRead: true },
    };
  },
};

/** S5 — the agent writes marker.txt with the wrong content. */
export const SCENARIO_WRONG_CONTENT: Scenario = {
  id: "S5",
  name: "wrong-content",
  prompt: 'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  transcript: TRANSCRIPT_WRONG_CONTENT,
  judge: async ({ metrics, fixtureRoot, expected }) => {
    const gt = await checkGroundTruth(fixtureRoot, expected);
    if (!gt.ok) {
      // The ground-truth check already captures the content mismatch.
      return {
        scenarioId: "S5",
        verdict: "fail",
        reason: `Ground-truth check failed: missing [${gt.missing.join(", ") || "none"}], mismatched [${gt.mismatch.join(", ") || "none"}]`,
        metrics,
        detail: { ...gt },
      };
    }
    return {
      scenarioId: "S5",
      verdict: "pass",
      reason: "marker.txt exists on disk with content 'hello'.",
      metrics,
      detail: { ...gt },
    };
  },
};

/** All scenarios, in order. */
export const ALL_SCENARIOS: Scenario[] = [
  SCENARIO_AGENTIC_SUCCESS,
  SCENARIO_CHAT_FAILURE,
  SCENARIO_MULTI_STEP,
  SCENARIO_STREAM_ERROR,
  SCENARIO_RETRY_LOOP,
  SCENARIO_WRONG_CONTENT,
];
