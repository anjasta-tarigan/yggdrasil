/**
 * Yggdrasil agentic eval harness.
 *
 * Public entry point — re-exports the parser, metrics, scenarios, and runner
 * so consumers can do:
 *
 * ```ts
 * import { runAllLive, ALL_SCENARIOS } from "@/evals/harness";
 * ```
 */
export type {
  UiMessageChunk,
  ToolCall,
  RunMetrics,
  EvaluationResult,
  Verdict,
  Scenario,
  VerifyResult,
  GroundTruthFile,
} from "./contracts";
export { parseUiMessageStream, splitSseEvents, drainStreamToText } from "./parse-stream";
export { computeMetrics, buildToolCalls, findRepeatedToolCalls } from "./metrics";
export {
  evaluateScenario,
  evaluateWithTranscript,
  prepareFixture,
  cleanupFixtures,
} from "./evaluate";
export {
  FetchTransport,
  assertLoopbackUrl,
  runScenarioLive,
  runAllLive,
  type HarnessTransport,
  type ChatRequestBody,
  type HttpResponse,
  type RunOptions,
} from "./run";

// ── Live scenarios (S0–S5) ──────────────────────────────────────────────
export { ALL_SCENARIOS } from "./scenarios";
export {
  SCENARIO_S0_SIMPLE_WRITE,
  SCENARIO_S1_TOOL_CALL_REQUIRED,
  SCENARIO_S2_ERROR_RECOVERY,
  SCENARIO_S3_NO_RETRY_LOOP,
  SCENARIO_S4_MULTI_STEP_READ_WRITE,
  SCENARIO_S5_CONTENT_CORRECTNESS,
} from "./scenarios";

// ── Self-test scenarios (T0–T5) ────────────────────────────────────────
export { SELFTEST_SCENARIOS } from "./selftest-scenarios";
export {
  SCENARIO_T0_AGENTIC_SUCCESS,
  SCENARIO_T1_CHAT_FAILURE,
  SCENARIO_T2_STREAM_ERROR,
  SCENARIO_T3_RETRY_LOOP,
  SCENARIO_T4_MULTI_STEP,
  SCENARIO_T5_WRONG_CONTENT,
} from "./selftest-scenarios";
