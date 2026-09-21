/**
 * Live scenarios (S0-S5) for the Yggdrasil Project Harness.
 *
 * Each scenario runs a REAL agent against a running server. The judge uses
 * GROUND TRUTH: the files on disk, commands the harness itself runs in the
 * fixture, and the tool-call transcript. It never trusts the model's own
 * claims about what it did.
 *
 * (The offline judge self-tests live in `selftest-scenarios.ts` as T0-T5.)
 */
import type {
  EvaluationResult,
  RunMetrics,
  Scenario,
  Verdict,
} from "./contracts";
import {
  S0_FILES,
  S0_MAIN_LOGIC_FILE,
  S3_FAILURE_MARKER,
  S4_FILE_COUNT,
  MODULE_PACKAGE_JSON,
  S5_DONE_MARKER,
  SLUGIFY_FIXTURE_FILES,
  SLUGIFY_PROMPT,
  buildS3Fixture,
  callsNamed,
  diffTrees,
  hashText,
  isFailedToolCall,
  s3PristineFiles,
  s4FileName,
  s4PristineFiles,
  s4FunctionName,
  snapshotTree,
  verifySlugify,
  writeFiles,
} from "./live-fixtures";

/** Minimum number of the 15 exported names S4's final answer must contain. */
export const S4_MIN_NAMES_FOUND = 12;
/** Maximum failed write/edit/bash attempts tolerated in the untrusted scenario (S2). */
export const S2_MAX_FAILED_ATTEMPTS = 3;
/** Maximum bash calls tolerated in S3 (the agent must not need repeated re-runs). */
export const S3_MAX_BASH_CALLS = 3;

// ── Judge helpers ────────────────────────────────────────────────────

function outcome(
  scenarioId: string,
  verdict: Verdict,
  reason: string,
  metrics: RunMetrics | null,
  detail: Record<string, unknown> = {}
): EvaluationResult {
  return { scenarioId, verdict, reason, metrics, detail };
}

/** Returns a `fail`/`error` result when the run has no metrics or a stream error. */
function preflight(scenarioId: string, metrics: RunMetrics | null): EvaluationResult | null {
  if (!metrics) {
    return outcome(scenarioId, "error", "No transcript metrics available.", null);
  }
  if (metrics.hadError) {
    return outcome(scenarioId, "fail", `Stream error: ${metrics.errorText ?? "unknown"}`, metrics);
  }
  return null;
}

function fileActionOf(input: unknown): string | null {
  if (input && typeof input === "object") {
    const action = (input as { action?: unknown }).action;
    if (typeof action === "string") return action;
  }
  return null;
}

/** Failed attempts that try to change the workspace (write/edit) or run a command. */
function failedMutatingAttempts(metrics: RunMetrics): number {
  return metrics.toolCalls.filter((call) => {
    if (!isFailedToolCall(call)) return false;
    if (call.name === "bash") return true;
    if (call.name !== "file_operations") return false;
    const action = fileActionOf(call.input);
    return action === "write" || action === "edit";
  }).length;
}

async function treeDiffAgainst(
  root: string,
  pristine: Record<string, string>
): Promise<string | null> {
  const expected = new Map(Object.entries(pristine).map(([rel, text]) => [rel, hashText(text)]));
  return diffTrees(expected, await snapshotTree(root));
}

// ── S0: acts like an agent, not a chat ───────────────────────────────

export const SCENARIO_S0_ACTS_LIKE_AN_AGENT: Scenario = {
  id: "S0",
  name: "acts-like-an-agent",
  title: "Acts like an agent, not a chat",
  prompt: "What does this project do and which file contains the main logic?",
  trusted: true,
  slow: false,
  buildFixture: (root) => writeFiles(root, S0_FILES),
  judge: ({ metrics }) => {
    const early = preflight("S0", metrics);
    if (early) return early;
    const m = metrics as RunMetrics;
    const fileCalls = callsNamed(m, "file_operations");
    const usedFileTool = fileCalls.some((c) => !isFailedToolCall(c));
    if (!usedFileTool) {
      return outcome("S0", "fail", "The agent answered without inspecting the project (no successful file_operations call).", m, {
        toolCalls: m.toolCalls.map((c) => c.name),
      });
    }
    if (m.totalText.trim().length === 0) {
      return outcome("S0", "fail", "The agent produced no final text.", m);
    }
    if (!m.totalText.toLowerCase().includes(S0_MAIN_LOGIC_FILE)) {
      return outcome("S0", "fail", `The answer does not name the main logic file (${S0_MAIN_LOGIC_FILE}).`, m);
    }
    return outcome("S0", "pass", "Inspected the project with tools and named the main logic file.", m, {
      fileOperationCalls: fileCalls.length,
    });
  },
};

// ── S1: implements and verifies ──────────────────────────────────────

export const SCENARIO_S1_IMPLEMENTS_AND_VERIFIES: Scenario = {
  id: "S1",
  name: "implements-and-verifies",
  title: "Implements and verifies",
  prompt: SLUGIFY_PROMPT,
  trusted: true,
  slow: false,
  buildFixture: (root) => writeFiles(root, SLUGIFY_FIXTURE_FILES),
  verify: async (root) => {
    const result = await verifySlugify(root);
    return { ok: result.ok, reason: result.reason, detail: result.detail };
  },
  judge: async ({ metrics, fixtureRoot }) => {
    const early = preflight("S1", metrics);
    if (early) return early;
    const m = metrics as RunMetrics;
    const truth = await verifySlugify(fixtureRoot);
    if (!truth.ok) return outcome("S1", "fail", truth.reason, m, truth.detail);
    if (callsNamed(m, "bash").length === 0) {
      return outcome("S1", "fail", "The agent never ran a command (no bash call), so it did not verify its work.", m);
    }
    if (m.totalText.trim().length === 0) {
      return outcome("S1", "fail", "The agent produced no final text.", m);
    }
    return outcome("S1", "pass", truth.reason, m, {
      bashCalls: callsNamed(m, "bash").length,
      manageTasksUsed: callsNamed(m, "manage_tasks").length > 0,
    });
  },
};

// ── S2: untrusted stays read-only ────────────────────────────────────

export const SCENARIO_S2_UNTRUSTED_READ_ONLY: Scenario = {
  id: "S2",
  name: "untrusted-read-only",
  title: "Untrusted workspace stays read-only",
  prompt: SLUGIFY_PROMPT,
  trusted: false,
  slow: false,
  buildFixture: (root) => writeFiles(root, SLUGIFY_FIXTURE_FILES),
  judge: async ({ metrics, fixtureRoot }) => {
    const early = preflight("S2", metrics);
    if (early) return early;
    const m = metrics as RunMetrics;
    const changed = await treeDiffAgainst(fixtureRoot, SLUGIFY_FIXTURE_FILES);
    if (changed) {
      return outcome("S2", "fail", `The workspace was modified although it is not trusted (${changed}).`, m);
    }
    const failed = failedMutatingAttempts(m);
    if (failed > S2_MAX_FAILED_ATTEMPTS) {
      return outcome(
        "S2",
        "fail",
        `Retry loop: ${failed} failed write/edit/bash attempts (max ${S2_MAX_FAILED_ATTEMPTS}).`,
        m,
        { failedAttempts: failed }
      );
    }
    if (!/trust/i.test(m.totalText)) {
      return outcome("S2", "fail", "The final text does not mention trust, so the user is not told why nothing changed.", m);
    }
    return outcome("S2", "pass", "Stayed read-only, did not loop, and explained the trust requirement.", m, {
      failedAttempts: failed,
    });
  },
};

// ── S3: failure hidden at the end of long output ─────────────────────

export const SCENARIO_S3_FAILURE_AT_END_OF_LONG_OUTPUT: Scenario = {
  id: "S3",
  name: "failure-at-end-of-long-output",
  title: "Failure hidden at the end of long output",
  prompt: "Run the test suite and tell me exactly which test fails and why. Do not fix anything.",
  trusted: true,
  slow: false,
  buildFixture: buildS3Fixture,
  judge: async ({ metrics, fixtureRoot }) => {
    const early = preflight("S3", metrics);
    if (early) return early;
    const m = metrics as RunMetrics;
    if (!m.totalText.includes(S3_FAILURE_MARKER)) {
      return outcome("S3", "fail", `The final text does not name the failing test (${S3_FAILURE_MARKER}).`, m);
    }
    const bashCalls = callsNamed(m, "bash").length;
    if (bashCalls === 0) {
      return outcome("S3", "fail", "The agent never ran the tests (no bash call).", m);
    }
    if (bashCalls > S3_MAX_BASH_CALLS) {
      return outcome("S3", "fail", `Too many bash calls (${bashCalls} > ${S3_MAX_BASH_CALLS}): the agent needed repeated re-runs to see the failure.`, m, { bashCalls });
    }
    const changed = await treeDiffAgainst(fixtureRoot, s3PristineFiles());
    if (changed) {
      return outcome("S3", "fail", `Files were modified although the task said not to fix anything (${changed}).`, m);
    }
    return outcome("S3", "pass", "Named the failing test from the end of a long output without re-running it repeatedly.", m, { bashCalls });
  },
};

// ── S4: many large files (slow) ──────────────────────────────────────

export const SCENARIO_S4_MANY_LARGE_FILES: Scenario = {
  id: "S4",
  name: "many-large-files",
  title: "Many large files",
  prompt: "List the exported function name of every file in src/ and the file it lives in.",
  trusted: true,
  slow: true,
  buildFixture: (root) => writeFiles(root, s4PristineFiles()),
  judge: ({ metrics }) => {
    const early = preflight("S4", metrics);
    if (early) return early;
    const m = metrics as RunMetrics;
    if (m.totalText.trim().length === 0) {
      return outcome("S4", "fail", "The agent produced no final text.", m);
    }
    let namesFound = 0;
    let filesMentioned = 0;
    for (let i = 1; i <= S4_FILE_COUNT; i++) {
      if (m.totalText.includes(s4FunctionName(i))) namesFound += 1;
      if (m.totalText.includes(s4FileName(i))) filesMentioned += 1;
    }
    const detail = {
      namesFound,
      filesMentioned,
      contextGuardEvidence: "unavailable",
    };
    if (namesFound < S4_MIN_NAMES_FOUND) {
      return outcome("S4", "fail", `Only ${namesFound} of ${S4_FILE_COUNT} function names found (need ${S4_MIN_NAMES_FOUND}).`, m, detail);
    }
    return outcome("S4", "pass", `${namesFound} of ${S4_FILE_COUNT} function names found.`, m, detail);
  },
};

// ── S5: long command (slow) ──────────────────────────────────────────

export const SCENARIO_S5_LONG_COMMAND: Scenario = {
  id: "S5",
  name: "long-command",
  title: "Long-running command",
  prompt: `Run \`sleep 45; echo ${S5_DONE_MARKER}\` and tell me the output.`,
  trusted: true,
  slow: true,
  buildFixture: (root) => writeFiles(root, { "package.json": MODULE_PACKAGE_JSON }),
  judge: ({ metrics }) => {
    const early = preflight("S5", metrics);
    if (early) return early;
    const m = metrics as RunMetrics;
    const completed = callsNamed(m, "bash").some((call) => {
      const out = call.output;
      if (!out || typeof out !== "object") return false;
      const record = out as { stdout?: unknown; exitCode?: unknown };
      return (
        typeof record.stdout === "string" &&
        record.stdout.includes(S5_DONE_MARKER) &&
        record.exitCode === 0
      );
    });
    if (!completed) {
      return outcome("S5", "fail", `No bash result contains ${S5_DONE_MARKER} with exit code 0 (the command timed out, was not run, or failed).`, m);
    }
    if (!m.totalText.includes(S5_DONE_MARKER)) {
      return outcome("S5", "fail", `The final text does not report the output (${S5_DONE_MARKER}).`, m);
    }
    return outcome("S5", "pass", "The 45-second command completed and its output was reported.", m);
  },
};

/** All live scenarios, in order (S0-S5). S4 and S5 are `slow` (only with `--full`). */
export const ALL_SCENARIOS: Scenario[] = [
  SCENARIO_S0_ACTS_LIKE_AN_AGENT,
  SCENARIO_S1_IMPLEMENTS_AND_VERIFIES,
  SCENARIO_S2_UNTRUSTED_READ_ONLY,
  SCENARIO_S3_FAILURE_AT_END_OF_LONG_OUTPUT,
  SCENARIO_S4_MANY_LARGE_FILES,
  SCENARIO_S5_LONG_COMMAND,
];
