/**
 * SPIKE gate 9, round 3 — with a SERIALIZABLE model.
 *
 * Round 1/2 failed at `.args[1]` because `doStreamStep`'s second argument is the
 * MODEL, and `MockLanguageModelV4` is a class instance (not serializable).
 * `CompatibleLanguageModel = LanguageModelV4`, so the model must cross the step
 * boundary. This round uses a plain serializable model object, so tool shape is
 * the only remaining variable.
 */
import { WorkflowAgent } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";

const seen: Record<string, unknown> = {};
export function readSeen() {
  return seen;
}

/** A plain-object LanguageModelV4 that can cross the step boundary. */
function serializableModel(toolName: string) {
  let call = 0;
  return {
    specificationVersion: "v4" as const,
    provider: "spike",
    modelId: "spike-model",
    supportedUrls: {},
    async doStream() {
      call += 1;
      const parts =
        call === 1
          ? [
              {
                type: "tool-call" as const,
                toolCallId: `c_${toolName}`,
                toolName,
                input: JSON.stringify({ note: "spike" }),
              },
              {
                type: "finish" as const,
                finishReason: "tool-calls" as const,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ]
          : [
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", text: "done" },
              { type: "text-end" as const, id: "t" },
              {
                type: "finish" as const,
                finishReason: "stop" as const,
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };
}

// A: 'use step' + toolsContext, input+options signature (as the spec wants).
async function shapeAExecute(
  input: { note: string },
  opts: { context?: { canonicalRoot?: string; sessionId?: string } } = {}
) {
  "use step";
  seen.A = { note: input.note, context: opts?.context ?? null };
  return { shape: "A", note: input.note };
}

// F: no directive — should fail or run in workflow context.
async function shapeFExecute(input: { note: string }) {
  seen.F = { note: input.note };
  return { shape: "F", note: input.note };
}

function agentFor(toolName: string) {
  return new WorkflowAgent({
    model: serializableModel(toolName) as never,
    instructions: "spike",
    tools: {
      [toolName]: tool({
        description: toolName,
        inputSchema: z.object({ note: z.string() }),
        execute: toolName === "shape_a" ? shapeAExecute : shapeFExecute,
      }),
    } as never,
    toolsContext: {
      shape_a: { canonicalRoot: "/tmp/spike-root", sessionId: "sess_spike" },
    } as never,
  });
}

export async function runShapeA() {
  "use workflow";
  const r = await agentFor("shape_a").stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason, results: r.steps.flatMap((s) => s.toolResults ?? []).length };
}

export async function runShapeF() {
  "use workflow";
  const r = await agentFor("shape_f").stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason, results: r.steps.flatMap((s) => s.toolResults ?? []).length };
}
