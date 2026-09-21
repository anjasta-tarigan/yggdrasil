/**
 * SPIKE gate 9 runtime — does a REAL provider instance cross the step boundary,
 * and does `wrapLanguageModel` break it?
 *
 * Findings so far:
 *  - doStreamStep(prompt, modelInit, ...) takes the model as arg 2 → it must serialize.
 *  - @ai-sdk/openai-compatible implements WORKFLOW_SERIALIZE / WORKFLOW_DESERIALIZE.
 *  - yggdrasil wraps its model in `wrapLanguageModel({ model, middleware })`.
 *
 * Question: which of these survives the boundary?
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { WorkflowAgent } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";

const seen: Record<string, unknown> = {};
export function readSeen() {
  return seen;
}

/** A tool with 'use step' that records what `context` it received. */
async function probeExecute(
  input: { note: string },
  opts: { context?: Record<string, unknown> } = {}
) {
  "use step";
  seen.toolContext = opts?.context ?? null;
  seen.toolContextReceived = opts?.context !== undefined;
  seen.input = input;
  return { ok: true, gotContext: opts?.context !== undefined };
}

function makeTools() {
  return {
    probe: tool({
      description: "probe",
      inputSchema: z.object({ note: z.string() }),
      execute: probeExecute,
    }),
  };
}

/** Provider built the way yggdrasil builds it. */
function yggdrasilStyleModel() {
  const provider = createOpenAICompatible({
    name: "spike",
    baseURL: "http://127.0.0.1:9/v1", // never contacted; we only test serialization
    apiKey: "spike-key",
  });
  return wrapLanguageModel({
    model: provider.chatModel("spike-model"),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  });
}

/** Provider WITHOUT the wrapLanguageModel wrapper. */
function bareModel() {
  const provider = createOpenAICompatible({
    name: "spike",
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "spike-key",
  });
  return provider.chatModel("spike-model");
}

function agentWith(model: unknown) {
  return new WorkflowAgent({
    model: model as never,
    instructions: "spike",
    tools: makeTools() as never,
    toolsContext: {
      probe: { canonicalRoot: "/tmp/spike-root", sessionId: "sess_spike" },
    } as never,
  });
}

/** Wrapped model (yggdrasil's shape). */
export async function runWrappedModel() {
  "use workflow";
  const r = await agentWith(yggdrasilStyleModel()).stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason };
}

/** Bare provider model. */
export async function runBareModel() {
  "use workflow";
  const r = await agentWith(bareModel()).stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason };
}
