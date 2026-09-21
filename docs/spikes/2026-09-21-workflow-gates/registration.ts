/**
 * SPIKE gate 9 runtime, round 2 — class registration.
 *
 * Round 1: bare provider model serialized OK but failed with
 *   Class "class//@ai-sdk/openai-compatible@3.0.35//OpenAICompatibleChatLanguageModel" not found.
 * Docs: the SWC plugin auto-registers classes that implement WORKFLOW_SERIALIZE,
 * with a classId from file path + class name, "no manual registration required".
 *
 * Hypothesis: the provider class lives in node_modules and is not part of the
 * transformed app graph, so it is never registered. Re-exporting it from a
 * local (transformed) module should register it.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { WorkflowAgent, type CompatibleLanguageModel } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";

const seen: Record<string, unknown> = {};
export function readSeen() {
  return seen;
}

/**
 * A LOCAL class implementing the serialization protocol, referencing the
 * provider. If a locally-defined serializable class crosses the boundary, the
 * "class not found" problem is about discovery of node_modules classes.
 */
class SpikeModelHolder {
  constructor(
    public readonly baseURL: string,
    public readonly modelId: string,
    public readonly apiKey: string
  ) {}

  static [Symbol.for("workflow-serialize")](instance: SpikeModelHolder) {
    return {
      baseURL: instance.baseURL,
      modelId: instance.modelId,
      apiKey: instance.apiKey,
    };
  }

  static [Symbol.for("workflow-deserialize")](options: {
    baseURL: string;
    modelId: string;
    apiKey: string;
  }) {
    return new SpikeModelHolder(options.baseURL, options.modelId, options.apiKey);
  }

  build(): CompatibleLanguageModel {
    const provider = createOpenAICompatible({
      name: "spike",
      baseURL: this.baseURL,
      apiKey: this.apiKey,
    });
    return provider.chatModel(this.modelId) as unknown as CompatibleLanguageModel;
  }
}

async function probeExecute(
  input: { note: string },
  opts: { context?: Record<string, unknown> } = {}
) {
  "use step";
  seen.toolContext = opts?.context ?? null;
  seen.toolContextReceived = opts?.context !== undefined;
  return { ok: true, gotContext: opts?.context !== undefined };
}

export async function runLocalHolder() {
  "use workflow";
  const holder = new SpikeModelHolder("http://127.0.0.1:9/v1", "spike-model", "k");
  const agent = new WorkflowAgent({
    model: holder.build(),
    instructions: "spike",
    tools: {
      probe: tool({
        description: "probe",
        inputSchema: z.object({ note: z.string() }),
        execute: probeExecute,
      }),
    } as never,
    toolsContext: {
      probe: { canonicalRoot: "/tmp/spike-root", sessionId: "sess_spike" },
    } as never,
  });
  const r = await agent.stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason };
}
