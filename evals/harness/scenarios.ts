/**
 * Live scenarios for the Yggdrasil agentic harness.
 *
 * Each scenario exercises a real agent run against a live server. The harness
 * creates a temporary fixture directory, sends the scenario's `prompt` to the
 * agent, and then runs the `judge` to verify the outcome.
 *
 * Ground truth is checked on disk — not from the model's tool results — using
 * the `verify` method (Spec §3.1).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Scenario, VerifyResult, GroundTruthFile } from "./contracts";

/** The marker file every agentic scenario writes. */
const MARKER: GroundTruthFile = {
  relativePath: "marker.txt",
  content: "hello",
};

/**
 * Verifies that `marker.txt` exists in `root` with exactly the content `"hello"`.
 * Used by both the `verify` method and the `judge` of each live scenario.
 */
async function verifyMarkerFile(root: string): Promise<VerifyResult> {
  const abs = path.join(root, "marker.txt");
  let actual: string;
  try {
    actual = await fs.readFile(abs, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: "marker.txt is missing",
      detail: { error: err instanceof Error ? err.message : String(err) },
    };
  }
  if (actual !== "hello") {
    return {
      ok: false,
      reason: `marker.txt content mismatch: expected "hello", got ${JSON.stringify(actual)}`,
      detail: { expected: "hello", actual },
    };
  }
  return {
    ok: true,
    reason: "marker.txt exists with content 'hello'.",
    detail: { path: "marker.txt", content: "hello" },
  };
}

/**
 * S0 — Simple File Write.
 *
 * The agent must write `marker.txt` containing exactly `"hello"` using the
 * `file_operations` tool. No initial files are required.
 */
export const SCENARIO_S0_SIMPLE_WRITE: Scenario = {
  id: "S0",
  name: "simple-write",
  title: "Simple File Write",
  prompt:
    'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  slow: false,
  verify: verifyMarkerFile,
  judge: async ({ metrics, fixtureRoot }) => {
    const result = await verifyMarkerFile(fixtureRoot);
    if (!result.ok) {
      return {
        scenarioId: "S0",
        verdict: "fail",
        reason: result.reason,
        metrics,
        detail: { ...result.detail },
      };
    }
    if (metrics && metrics.repeatedToolCalls.length > 0) {
      return {
        scenarioId: "S0",
        verdict: "fail",
        reason: `Retry loop detected: ${metrics.repeatedToolCalls.length} duplicate tool call(s) re-issued.`,
        metrics,
        detail: { ...result.detail, repeatedCount: metrics.repeatedToolCalls.length },
      };
    }
    return {
      scenarioId: "S0",
      verdict: "pass",
      reason: result.reason,
      metrics,
      detail: { ...result.detail },
    };
  },
};

/**
 * S1 — Tool Call Required.
 *
 * Same task as S0, but the judge additionally requires that the agent made at
 * least one tool call (i.e. it used the `file_operations` tool rather than
 * just chatting).
 */
export const SCENARIO_S1_TOOL_CALL_REQUIRED: Scenario = {
  id: "S1",
  name: "tool-call-required",
  title: "Tool Call Required",
  prompt:
    'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  slow: false,
  verify: verifyMarkerFile,
  judge: async ({ metrics, fixtureRoot }) => {
    const result = await verifyMarkerFile(fixtureRoot);
    if (!result.ok) {
      return {
        scenarioId: "S1",
        verdict: "fail",
        reason: result.reason,
        metrics,
        detail: { ...result.detail },
      };
    }
    const toolCallCount = metrics?.toolCalls.length ?? 0;
    if (toolCallCount === 0) {
      return {
        scenarioId: "S1",
        verdict: "fail",
        reason: "File written correctly but no tool calls were observed — expected the agent to use file_operations.",
        metrics,
        detail: { ...result.detail, toolCallCount: 0 },
      };
    }
    return {
      scenarioId: "S1",
      verdict: "pass",
      reason: result.reason,
      metrics,
      detail: { ...result.detail, toolCallCount },
    };
  },
};

/**
 * S2 — Error Recovery.
 *
 * The prompt asks the agent to recover from a failed first attempt. The judge
 * verifies the file was written and that no error chunk was emitted in the
 * stream (i.e. the agent did not time out or error out).
 */
export const SCENARIO_S2_ERROR_RECOVERY: Scenario = {
  id: "S2",
  name: "error-recovery",
  title: "Error Recovery",
  prompt:
    'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello". If the first attempt fails, try a different approach.',
  expectedFiles: [MARKER],
  slow: false,
  verify: verifyMarkerFile,
  judge: async ({ metrics, fixtureRoot }) => {
    const result = await verifyMarkerFile(fixtureRoot);
    if (!result.ok) {
      return {
        scenarioId: "S2",
        verdict: "fail",
        reason: result.reason,
        metrics,
        detail: { ...result.detail },
      };
    }
    if (metrics && metrics.hadError) {
      return {
        scenarioId: "S2",
        verdict: "fail",
        reason: `Stream error detected: ${metrics.errorText ?? "unknown error"}`,
        metrics,
        detail: { ...result.detail, errorText: metrics.errorText },
      };
    }
    return {
      scenarioId: "S2",
      verdict: "pass",
      reason: result.reason,
      metrics,
      detail: { ...result.detail },
    };
  },
};

/**
 * S3 — No Retry Loop.
 *
 * Verifies the agent wrote the file correctly and did not re-issue identical
 * tool calls (a signal of a retry loop).
 */
export const SCENARIO_S3_NO_RETRY_LOOP: Scenario = {
  id: "S3",
  name: "no-retry-loop",
  title: "No Retry Loop",
  prompt:
    'Using the file_operations tool, write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  slow: false,
  verify: verifyMarkerFile,
  judge: async ({ metrics, fixtureRoot }) => {
    const result = await verifyMarkerFile(fixtureRoot);
    if (!result.ok) {
      return {
        scenarioId: "S3",
        verdict: "fail",
        reason: result.reason,
        metrics,
        detail: { ...result.detail },
      };
    }
    if (metrics && metrics.repeatedToolCalls.length > 0) {
      return {
        scenarioId: "S3",
        verdict: "fail",
        reason: `Retry loop detected: ${metrics.repeatedToolCalls.length} duplicate tool call(s) re-issued.`,
        metrics,
        detail: { ...result.detail, repeatedCount: metrics.repeatedToolCalls.length },
      };
    }
    return {
      scenarioId: "S3",
      verdict: "pass",
      reason: result.reason,
      metrics,
      detail: { ...result.detail },
    };
  },
};

/**
 * S4 — Multi-Step Read-Write (slow).
 *
 * The prompt asks the agent to first read `note.txt`, then write `marker.txt`.
 * The fixture is pre-populated with `note.txt` via `buildFixture`. The judge
 * verifies the file was written and that at least one read tool call was
 * observed.
 */
export const SCENARIO_S4_MULTI_STEP_READ_WRITE: Scenario = {
  id: "S4",
  name: "multi-step-read-write",
  title: "Multi-Step Read-Write",
  prompt:
    'First read "note.txt", then using the file_operations tool write a file named "marker.txt" containing exactly "hello".',
  expectedFiles: [MARKER],
  slow: true,
  buildFixture: async (root: string) => {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "note.txt"), "ready", "utf8");
  },
  verify: verifyMarkerFile,
  judge: async ({ metrics, fixtureRoot }) => {
    const result = await verifyMarkerFile(fixtureRoot);
    if (!result.ok) {
      return {
        scenarioId: "S4",
        verdict: "fail",
        reason: result.reason,
        metrics,
        detail: { ...result.detail },
      };
    }
    const hasRead = (metrics?.toolCalls ?? []).some(
      (c) =>
        c.name === "file_operations" &&
        (c.input as { action?: string })?.action === "read"
    );
    if (!hasRead) {
      return {
        scenarioId: "S4",
        verdict: "fail",
        reason: "File written correctly but no read tool call was observed — expected a read-then-write flow.",
        metrics,
        detail: { ...result.detail, hasRead: false },
      };
    }
    return {
      scenarioId: "S4",
      verdict: "pass",
      reason: "Multi-step flow completed: note.txt read, marker.txt written with 'hello'.",
      metrics,
      detail: { ...result.detail, hasRead: true },
    };
  },
};

/**
 * S5 — Content Correctness (slow).
 *
 * The prompt emphasizes "exactly the word 'hello' and nothing else". The judge
 * verifies the file content is an exact match (no trailing whitespace or
 * extra characters) and that no retry loop occurred.
 */
export const SCENARIO_S5_CONTENT_CORRECTNESS: Scenario = {
  id: "S5",
  name: "content-correctness",
  title: "Content Correctness",
  prompt:
    'Using the file_operations tool, write a file named "marker.txt" containing exactly the word "hello" and nothing else.',
  expectedFiles: [MARKER],
  slow: true,
  verify: verifyMarkerFile,
  judge: async ({ metrics, fixtureRoot }) => {
    const result = await verifyMarkerFile(fixtureRoot);
    if (!result.ok) {
      return {
        scenarioId: "S5",
        verdict: "fail",
        reason: result.reason,
        metrics,
        detail: { ...result.detail },
      };
    }
    if (metrics && metrics.repeatedToolCalls.length > 0) {
      return {
        scenarioId: "S5",
        verdict: "fail",
        reason: `Retry loop detected: ${metrics.repeatedToolCalls.length} duplicate tool call(s) re-issued.`,
        metrics,
        detail: { ...result.detail, repeatedCount: metrics.repeatedToolCalls.length },
      };
    }
    return {
      scenarioId: "S5",
      verdict: "pass",
      reason: result.reason,
      metrics,
      detail: { ...result.detail },
    };
  },
};

/** All live scenarios, in order (S0–S5). */
export const ALL_SCENARIOS: Scenario[] = [
  SCENARIO_S0_SIMPLE_WRITE,
  SCENARIO_S1_TOOL_CALL_REQUIRED,
  SCENARIO_S2_ERROR_RECOVERY,
  SCENARIO_S3_NO_RETRY_LOOP,
  SCENARIO_S4_MULTI_STEP_READ_WRITE,
  SCENARIO_S5_CONTENT_CORRECTNESS,
];
