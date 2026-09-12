import type { ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage } from "ai";
import { getWritable } from "workflow";
import { createDurableAgent } from "@/lib/ai/durable-agents";
import type { SubagentConfig } from "@/lib/ai/subagents-service";

/**
 * Default configuration for the durable chat workflow.
 *
 * Grants all capability groups so the workflow can be used as a general-purpose
 * conversational agent out of the box.  Callers can pass a different
 * {@link SubagentConfig} to restrict tools, change the model, or bump the
 * step budget.
 */
export const DEFAULT_DURABLE_CONFIG: SubagentConfig = {
  id: "durable-default",
  name: "DurableAgent",
  instructions:
    "You are DurableAgent, a helpful assistant that uses tools to accomplish tasks. Complete the assigned task autonomously within your step budget.",
  tools: ["web_search", "web_fetch", "memory", "sandbox", "tasks"],
  enabled: true,
  maxSteps: 15,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * A durable, crash-resilient chat workflow.
 *
 * The `'use workflow'` directive marks this function as a workflow entry point:
 * the workflow runtime serialises execution to durable storage between steps,
 * so an interrupted run can be resumed without losing progress.
 *
 * Inside the workflow, each tool call (wrapped with `'use step'` by
 * {@link createDurableAgent}) becomes a replayable step.  The
 * `ModelCallStreamPart` stream produced by `agent.stream()` is piped into a
 * `WritableStream` from `getWritable()` so it survives across resumes, and the
 * API route converts it to `UIMessageChunk`s for the client.
 */
export async function chatWorkflow(
  messages: UIMessage[],
  config: SubagentConfig = DEFAULT_DURABLE_CONFIG,
) {
  "use workflow";

  const agent = await createDurableAgent(config);
  const modelMessages = await convertToModelMessages(messages);

  return agent.stream({
    messages: modelMessages,
    writable: getWritable<ModelCallStreamPart>(),
    stopWhen: isStepCount(config.maxSteps),
  });
}
