/**
 * SPIKE gate 9, round 3b — model built INSIDE the step (step-as-factory).
 *
 * Round 3 hit the class-registration wall again because the provider instance
 * crossed the boundary. This round passes only serializable inputs (baseURL,
 * modelId, key) and builds the model inside a 'use step' factory — the strategy
 * the spec recommends. If the turn completes, `toolsContext` can finally be read.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { WorkflowAgent, type CompatibleLanguageModel } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

// ── Mock provider server ─────────────────────────────────────────────────────
let server: Server | undefined;

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function startMockProvider() {
  "use step";
  if (server) {
    const p = (server.address() as AddressInfo).port;
    return { baseURL: `http://127.0.0.1:${p}/v1` };
  }
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
      if (turn === 1) {
        res.write(
          sse({
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
                      function: { name: "probe", arguments: JSON.stringify({ note: "hello" }) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })
        );
        res.write(
          sse({
            id: "1",
            object: "chat.completion.chunk",
            created: 1,
            model: "spike-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          })
        );
      } else {
        res.write(
          sse({
            id: "2",
            object: "chat.completion.chunk",
            created: 1,
            model: "spike-model",
            choices: [
              { index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null },
            ],
          })
        );
        res.write(
          sse({
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
  return { baseURL: `http://127.0.0.1:${port}/v1` };
}

export async function stopMockProvider() {
  "use step";
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
}

// ── Model factory: outer captures serializable args, inner is a step ─────────
function modelFactory(baseURL: string, modelId: string, apiKey: string) {
  return async () => {
    "use step";
    const provider = createOpenAICompatible({ name: "spike", baseURL, apiKey });
    return provider.chatModel(modelId) as unknown as CompatibleLanguageModel;
  };
}

// ── Tool recording the context it receives ───────────────────────────────────
const record: { called: boolean; context?: unknown; input?: unknown } = { called: false };
export function readRecord() {
  return record;
}

async function probeExecute(
  input: { note: string },
  opts: { context?: Record<string, unknown> } = {}
) {
  "use step";
  record.called = true;
  record.input = input;
  record.context = opts?.context ?? null;
  return { ok: true, gotContext: opts?.context !== undefined, note: input.note };
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export async function toolsContextWorkflow() {
  "use workflow";
  const { baseURL } = await startMockProvider();

  const agent = new WorkflowAgent({
    model: modelFactory(baseURL, "spike-model", "spike-key") as never,
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
