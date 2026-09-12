import { hasToolCall, isStepCount, type StopCondition, type ToolSet } from "ai";

/**
 * Composite stop conditions for the main chat agent loop.
 *
 * The loop terminates when **any** condition in the returned array is met:
 *
 * 1. `isStepCount(15)` — hard cap at 15 steps so multi-tool chains
 *    (search → fetch → remember → artifact) don't exhaust the model
 *    mid-task.
 * 2. `hasToolCall('ask_user_question')` — when the agent calls
 *    `ask_user_question` (defined in `@/lib/ai/tools/core.ts`), the loop
 *    should stop so the client can render the interactive question UI and
 *    wait for user input, rather than continuing to run.
 *
 * `stopWhen` in `streamText` accepts an `Arrayable<StopCondition>`; passing
 * an array causes the loop to stop when any condition returns `true`.
 */
export function createChatStopConditions(): Array<StopCondition<ToolSet>> {
  return [isStepCount(15), hasToolCall("ask_user_question")];
}
