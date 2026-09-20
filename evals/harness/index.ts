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
} from "./run";
export { ALL_SCENARIOS } from "./scenarios";
export {
  SCENARIO_AGENTIC_SUCCESS,
  SCENARIO_CHAT_FAILURE,
  SCENARIO_MULTI_STEP,
  SCENARIO_STREAM_ERROR,
  SCENARIO_RETRY_LOOP,
  SCENARIO_WRONG_CONTENT,
} from "./scenarios";
