import { WorkflowAgent } from "@ai-sdk/workflow";
import { isStepCount } from "ai";
import { resolveModel, buildSubagentTools } from "./subagent-runner";
import type { SubagentConfig } from "./subagents-service";

/**
 * Wrap each tool's `execute` function with a `'use step'` directive so the
 * workflow runtime treats tool execution as a durable step — gaining retry,
 * observability, and crash-resilience for free.
 *
 * You cannot programmatically inject a directive into an existing function
 * body, so we create a thin async wrapper whose body starts with
 * `'use step'` and delegates to the original `execute`.  Tools without an
 * `execute` function (e.g. client-side-only tools) are passed through
 * unchanged.
 *
 * We deliberately avoid importing `ToolSet` from `ai` here: the `ai` package
 * (v7) and `@ai-sdk/workflow` (v2) resolve to different major versions of
 * `@ai-sdk/provider-utils`, making their `ToolSet` types structurally
 * incompatible.  `Record<string, any>` sidesteps the version conflict — `any`
 * is assignable to every variant of the `Tool` interface — while still
 * preserving runtime correctness.
 */
function durableTool(
  tools: Record<string, any>
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [name, tool] of Object.entries(tools)) {
    const originalExecute = tool?.execute;

    if (typeof originalExecute !== "function") {
      result[name] = tool;
      continue;
    }

    result[name] = {
      ...tool,
      execute: async function (input: unknown, options: unknown) {
        'use step';
        return originalExecute(input, options);
      },
    };
  }

  return result;
}

/**
 * Build a durable `WorkflowAgent` from a stored {@link SubagentConfig}.
 *
 * This mirrors `buildSubagent()` from `subagent-runner.ts` — reusing its
 * `resolveModel` and `buildSubagentTools` — but swaps `ToolLoopAgent` for
 * `WorkflowAgent` and wraps every tool's `execute` with the `'use step'`
 * directive via {@link durableTool}.  The result is a subagent whose tool
 * calls survive crashes and can be retried/resumed by the workflow runtime.
 *
 * Lifecycle callbacks (`prepareCall`, `prepareStep`, `runtimeContext`) are
 * inherited from the Tasks 6/7/8/12 pattern on `ToolLoopAgent` and work
 * identically on `WorkflowAgent` since it accepts the same option shapes.
 */
export async function createDurableAgent(
  config: SubagentConfig
): Promise<WorkflowAgent> {
  return new WorkflowAgent({
    model: await resolveModel(config),
    instructions: config.instructions,
    tools: durableTool(buildSubagentTools(config)),
    stopWhen: isStepCount(config.maxSteps),
  });
}
