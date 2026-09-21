/**
 * SPIKE gate 9, round 4 — the DECISIVE test.
 *
 * Round 3 proved the model itself must be a step-as-factory: a plain object
 * carrying a `doStream` function fails at `.args[1].doStream` because functions
 * are not serializable.
 *
 * Round 4 uses the official step-as-factory shape for the model, and tests the
 * tool `execute` shapes as the only remaining variable.
 */
import { WorkflowAgent } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";

const seen: Record<string, unknown> = {};
export function readSeen() {
  return seen;
}

// ── Model as step-as-factory (outer captures serializable args) ───────────────
function modelFactory(toolName: string) {
  return async () => {
    "use step";
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
  };
}

// A: top-level 'use step' + toolsContext (spec's preferred tool shape).
async function shapeAExecute(
  input: { note: string },
  opts: { context?: { canonicalRoot?: string; sessionId?: string } } = {}
) {
  "use step";
  seen.A = { note: input.note, context: opts?.context ?? null };
  return { shape: "A", note: input.note };
}

// B: tool as step-as-factory.
function shapeBFactory(canonicalRoot: string) {
  return async (input: { note: string }) => {
    "use step";
    seen.B = { note: input.note, capturedRoot: canonicalRoot };
    return { shape: "B", note: input.note };
  };
}

function agentFor(which: "a" | "b") {
  const toolName = which === "a" ? "shape_a" : "shape_b";
  return new WorkflowAgent({
    model: modelFactory(toolName) as never,
    instructions: "spike",
    tools: {
      [toolName]: tool({
        description: toolName,
        inputSchema: z.object({ note: z.string() }),
        execute: which === "a" ? shapeAExecute : (shapeBFactory("/tmp/spike-root") as never),
      }),
    } as never,
    toolsContext: {
      shape_a: { canonicalRoot: "/tmp/spike-root", sessionId: "sess_spike" },
    } as never,
  });
}

export async function runShapeA() {
  "use workflow";
  const r = await agentFor("a").stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason, results: r.steps.flatMap((s) => s.toolResults ?? []).length };
}

export async function runShapeB() {
  "use workflow";
  const r = await agentFor("b").stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason, results: r.steps.flatMap((s) => s.toolResults ?? []).length };
}
