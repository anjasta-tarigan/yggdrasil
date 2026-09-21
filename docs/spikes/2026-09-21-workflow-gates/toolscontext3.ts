/**
 * SPIKE gate 9, round 3c — a LOCAL serializable language model.
 *
 * Findings: WorkflowAgent does NOT invoke a factory (doStreamStep treats it as the
 * model → "Unsupported model version undefined"). A node_modules provider class is
 * never registered. So: define the model class LOCALLY (a transformed file), so the
 * SWC plugin registers it, and implement the serialization protocol on it.
 *
 * This is the minimum needed to complete a turn and finally observe whether
 * `toolsContext` reaches `execute` as `context`.
 */
import { WorkflowAgent, type CompatibleLanguageModel } from "@ai-sdk/workflow";
import { tool } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

const WORKFLOW_SERIALIZE = Symbol.for("workflow-serialize");
const WORKFLOW_DESERIALIZE = Symbol.for("workflow-deserialize");

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

// ── A LOCAL language model class with the serialization protocol ─────────────
class SpikeLanguageModel {
  readonly specificationVersion = "v4";
  readonly provider = "spike";
  readonly modelId: string;
  readonly baseURL: string;
  private turn = 0;

  constructor(baseURL: string, modelId: string) {
    this.baseURL = baseURL;
    this.modelId = modelId;
  }

  static [WORKFLOW_SERIALIZE](instance: SpikeLanguageModel) {
    return { baseURL: instance.baseURL, modelId: instance.modelId };
  }

  static [WORKFLOW_DESERIALIZE](data: { baseURL: string; modelId: string }) {
    return new SpikeLanguageModel(data.baseURL, data.modelId);
  }

  get supportedUrls() {
    return {};
  }

  async doStream() {
    this.turn += 1;
    const first = this.turn === 1;
    const args = JSON.stringify({ note: "hello" });
    // V4 shapes: finishReason is { unified, raw }; usage is nested.
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const parts = first
      ? [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-input-start" as const, id: "call_1", toolName: "probe" },
          { type: "tool-input-delta" as const, id: "call_1", delta: args },
          { type: "tool-input-end" as const, id: "call_1" },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
            usage,
          },
        ]
      : [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "t" },
          { type: "text-delta" as const, id: "t", delta: "done" },
          { type: "text-end" as const, id: "t" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage,
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
  }

  /** Serialized state so the turn counter survives the boundary. */
  static [WORKFLOW_SERIALIZE](instance: SpikeLanguageModel) {
    return { baseURL: instance.baseURL, modelId: instance.modelId, turn: instance.turn };
  }
}

// ── Tool recording context ───────────────────────────────────────────────────
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
    model: new SpikeLanguageModel(baseURL, "spike-model") as unknown as CompatibleLanguageModel,
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
