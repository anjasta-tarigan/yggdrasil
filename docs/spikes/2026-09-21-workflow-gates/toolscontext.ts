/**
 * SPIKE gate 9, round 3 — does `toolsContext` actually reach `execute` as `context`?
 *
 * Previous rounds could not answer this: every run died at the model before a tool
 * executed. This round uses a LOCAL OpenAI-compatible HTTP server (started inside a
 * step, so it has Node access) that answers with a tool call first, then plain text.
 * That lets a real turn complete and the tool actually run.
 *
 * The tool records what `context` it received; the workflow returns that record.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { WorkflowAgent, type CompatibleLanguageModel } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

// ── Mock provider server (Node access → must live in a step) ──────────────────
let server: Server | undefined;
let baseURL = "";

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function startMockProvider() {
  "use step";
  if (server) return { baseURL };

  let turn = 0;
  server = createServer((req, res) => {
    if (!req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      turn += 1;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Turn 1: ask for the tool. Turn 2+: plain text so the loop can finish.
      if (turn === 1) {
        res.write(
          sseChunk({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "spike-model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "probe",
                        arguments: JSON.stringify({ note: "hello" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })
        );
        res.write(
          sseChunk({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "spike-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })
        );
      } else {
        res.write(
          sseChunk({
            id: "2",
            object: "chat.completion.chunk",
            created: 1,
            model: "spike-model",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "done" },
                finish_reason: null,
              },
            ],
          })
        );
        res.write(
          sseChunk({
            id: "2",
            object: "chat.completion.chunk",
            created: 1,
            model: "spike-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })
        );
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server!.address() as AddressInfo).port;
  baseURL = `http://127.0.0.1:${port}/v1`;
  return { baseURL };
}

// ── Tool that records the context it received ────────────────────────────────
const record: { context?: unknown; called: boolean } = { called: false };
export function readRecord() {
  return record;
}

async function probeExecute(
  input: { note: string },
  opts: { context?: Record<string, unknown> } = {}
) {
  "use step";
  record.called = true;
  record.context = opts?.context ?? null;
  return { ok: true, gotContext: opts?.context !== undefined, note: input.note };
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export async function toolsContextWorkflow() {
  "use workflow";
  const { baseURL: url } = await startMockProvider();

  const provider = createOpenAICompatible({
    name: "spike",
    baseURL: url,
    apiKey: "spike-key",
  });

  const agent = new WorkflowAgent({
    model: provider.chatModel("spike-model") as unknown as CompatibleLanguageModel,
    instructions: "spike",
    tools: {
      probe: tool({
        description: "probe",
        inputSchema: z.object({ note: z.string() }),
        execute: probeExecute,
      }),
    } as never,
    toolsContext: {
      probe: { canonicalRoot: "/tmp/spike-root", sessionId: "sess_spike", trusted: true },
    } as never,
  });

  const result = await agent.stream({
    messages: [{ role: "user", content: "go" }],
    writable: getWritable(),
  });

  return {
    finish: result.finishReason,
    toolResultCount: result.steps.flatMap((s) => s.toolResults ?? []).length,
    record,
  };
}

export async function stopMockProvider() {
  "use step";
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
}
