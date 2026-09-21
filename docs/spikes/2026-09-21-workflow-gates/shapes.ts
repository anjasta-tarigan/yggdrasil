/**
 * SPIKE — Stage 2 gate 9.
 *
 * Question: what shape of tool `execute` becomes a durable step, and does
 * `toolsContext` reach it? Tested by BUILD acceptance first (the compiler
 * rejects node usage outside a step), then by runtime observation.
 */
import { WorkflowAgent } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";
import { MockLanguageModelV4 } from "ai/test";

const observed: Record<string, unknown> = {};
export function readObserved() {
  return observed;
}

// ── A: top-level 'use step', fed by toolsContext (spec's preferred shape) ─────
async function shapeAExecute(
  input: { note: string },
  opts: { context?: { canonicalRoot?: string; sessionId?: string } } = {}
) {
  "use step";
  observed.shapeA = {
    note: input.note,
    contextReceived: opts?.context ?? null,
    hasContext: opts?.context !== undefined,
  };
  return { shape: "A", note: input.note };
}

// ── B: step-as-factory (outer captures serializable args only) ────────────────
function shapeBFactory(canonicalRoot: string) {
  return async (input: { note: string }) => {
    "use step";
    observed.shapeB = { note: input.note, capturedRoot: canonicalRoot };
    return { shape: "B", note: input.note };
  };
}

// ── C: durableTool-style HOF: wrapper closes over the caller's execute ────────
function durableToolLike<T extends Record<string, { execute?: unknown }>>(tools: T): T {
  const result = { ...tools } as T;
  for (const [name, t] of Object.entries(tools)) {
    const originalExecute = t?.execute;
    if (typeof originalExecute !== "function") continue;
    (result as Record<string, unknown>)[name] = {
      ...t,
      execute: async function (input: unknown, options: unknown) {
        "use step";
        observed.shapeC = { name, ran: true };
        return (originalExecute as (i: unknown, o: unknown) => unknown)(input, options);
      },
    };
  }
  return result;
}

function modelCalling(toolName: string) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const parts =
        call === 1
          ? [
              { type: "tool-call" as const, toolCallId: `c_${toolName}`, toolName, input: JSON.stringify({ note: "spike" }) },
              { type: "finish" as const, finishReason: "tool-calls" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ]
          : [
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", text: "done" },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
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
  });
}

const baseTools = {
  shape_a: tool({
    description: "A",
    inputSchema: z.object({ note: z.string() }),
    execute: shapeAExecute,
  }),
  shape_b: tool({
    description: "B",
    inputSchema: z.object({ note: z.string() }),
    execute: shapeBFactory("/tmp/spike-root"),
  }),
  shape_c: tool({
    description: "C",
    inputSchema: z.object({ note: z.string() }),
    execute: async ({ note }: { note: string }) => {
      observed.shapeCInner = { note };
      return { shape: "C-inner", note };
    },
  }),
};

const wrappedTools = durableToolLike(baseTools);

function agentFor(toolName: string) {
  return new WorkflowAgent({
    model: modelCalling(toolName) as never,
    instructions: "spike",
    tools: wrappedTools as never,
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

export async function runShapeB() {
  "use workflow";
  const r = await agentFor("shape_b").stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason, results: r.steps.flatMap((s) => s.toolResults ?? []).length };
}

export async function runShapeC() {
  "use workflow";
  const r = await agentFor("shape_c").stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason, results: r.steps.flatMap((s) => s.toolResults ?? []).length };
}
