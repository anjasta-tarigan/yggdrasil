/**
 * SPIKE gate 9, round 5 — model crossing the step boundary.
 *
 * Round 4 proved `modelInit` (arg 2 of doStreamStep) must be serializable, and a
 * provider instance's `doStream` is a function → SerializationError.
 *
 * This round asks: does a STRING model id cross the boundary cleanly? (We do not
 * need a successful generation to answer that — only whether serialization of
 * the step arguments succeeds and doStreamStep is entered.)
 */
import { WorkflowAgent } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";

const seen: Record<string, unknown> = {};
export function readSeen() {
  return seen;
}

async function shapeAExecute(
  input: { note: string },
  opts: { context?: { canonicalRoot?: string } } = {}
) {
  "use step";
  seen.A = { note: input.note, context: opts?.context ?? null };
  return { shape: "A" };
}

export async function runStringModel() {
  "use workflow";
  const agent = new WorkflowAgent({
    // String model id: serializable by construction.
    model: "openai/gpt-4o-mini",
    instructions: "spike",
    tools: {
      shape_a: tool({
        description: "A",
        inputSchema: z.object({ note: z.string() }),
        execute: shapeAExecute,
      }),
    } as never,
    toolsContext: { shape_a: { canonicalRoot: "/tmp/spike-root" } } as never,
  });
  const r = await agent.stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });
  return { finish: r.finishReason };
}
