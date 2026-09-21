import { tool, isStepCount } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";
// Relative, not `@/`: the workflow bundle resolves relative specifiers but not
// the tsconfig path alias for this import.
import { buildDurableModel } from "../lib/ai/durable-model-step";

/**
 * Captured in the workflow-function scope (NOT a module global) via
 * onToolExecutionEnd, which fires on the workflow side of the boundary. A module
 * global set inside the step's `probeExecute` would not propagate back here
 * because the step runs in a separate bundle.
 */
let observed: unknown = null;

async function probeExecute(
  input: { note: string },
  options: { context?: unknown } = {}
) {
  "use step";
  // The value is returned so onToolExecutionEnd (workflow scope) can capture it.
  return {
    ok: true,
    gotContext: options.context !== undefined,
    input,
    context: options.context ?? null,
  };
}

/**
 * Gate 9 proof: a real `WorkflowAgent` turn must deliver `toolsContext[probe]`
 * to `probeExecute`'s `context` argument.
 *
 * The model is the serializable {@link DurableLanguageModel}. A real turn needs the
 * provider rebuilt on the far side of the `doStreamStep` boundary, so the workflow
 * resolves the registry entry (`baseUrl` + `apiKey`) into plain `DurableModelInit`
 * inside a step and carries that through. The model rebuilds its provider in
 * `resolve()` from that plain data — no `node:fs`, no out-of-band attach.
 */
export async function toolsContextProbeWorkflow(
  init: DurableModelInit,
  prompt: string
) {
  "use workflow";
  observed = null;

  const resolvedInit = await resolveInit(init);
  const model = new DurableLanguageModel(resolvedInit);

  const agent = new WorkflowAgent({
    model: model as never,
    instructions:
      "Call the probe tool exactly once with note='hello', then stop.",
    tools: {
      probe: tool({
        description: "Records the context it receives.",
        inputSchema: z.object({ note: z.string() }),
        execute: probeExecute,
      }),
    } as never,
    toolsContext: {
      probe: { canonicalRoot: "/tmp/probe-root", sessionId: "sess_probe" },
    } as never,
    stopWhen: isStepCount(4),
    onToolExecutionEnd: ({ toolContext, output, success }) => {
      // `output` is what probeExecute returned on the step side; `toolContext` is
      // the per-tool toolsContext entry. Both arrive in the workflow scope.
      if (success && toolContext !== undefined) {
        observed = { context: toolContext, output: output ?? null };
      }
    },
  });

  const result = await agent.stream({
    messages: [{ role: "user", content: prompt }],
    writable: getWritable(),
  });

  return {
    finishReason: result.finishReason,
    observed,
  };
}

/**
 * Resolves the registry entry to plain connection data inside a step (registry
 * reads node:fs). The plain data is carried through the model's serializable
 * init so the model can rebuild its provider after the doStreamStep boundary.
 */
async function resolveInit(init: DurableModelInit): Promise<DurableModelInit> {
  "use step";
  return buildDurableModel(init);
}
