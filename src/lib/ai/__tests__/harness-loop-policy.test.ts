import { describe, it, expect, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  createHarnessLoop,
  createHarnessPrepareStep,
  createHarnessStopConditions,
  HARNESS_BASH_TIMEOUT_MS,
  HARNESS_MAX_STEPS,
  HARNESS_TIMEOUT,
} from "@/lib/ai/harness-loop";
import { syslog } from "@/lib/observability/log-store";

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
}));

// --- Stream part helpers (mirrors harness-loop.test.ts) ---

function makeStreamStart() {
  return { type: "stream-start" as const, warnings: [] };
}

function makeTextStart(id = "test-text-1") {
  return { type: "text-start" as const, id };
}

function makeTextDelta(delta: string, id = "test-text-1") {
  return { type: "text-delta" as const, id, delta };
}

function makeTextEnd(id = "test-text-1") {
  return { type: "text-end" as const, id };
}

function makeToolInputStart(id: string, toolName: string) {
  return { type: "tool-input-start" as const, id, toolName };
}

function makeToolInputDelta(id: string, delta: string) {
  return { type: "tool-input-delta" as const, id, delta };
}

function makeToolInputEnd(id: string) {
  return { type: "tool-input-end" as const, id };
}

function makeToolCall(id: string, toolName: string, input: string) {
  return { type: "tool-call" as const, toolCallId: id, toolName, input };
}

function makeFinish(
  finishReason: "stop" | "length" | "tool-calls" = "stop",
  usage?: { inputTokens: number; outputTokens: number }
) {
  const input = usage?.inputTokens ?? 1;
  const output = usage?.outputTokens ?? 1;
  return {
    type: "finish" as const,
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
    finishReason: { unified: finishReason, raw: finishReason },
  };
}

// --- Stop conditions ---

describe("createHarnessStopConditions", () => {
  it("returns exactly one condition that trips only at HARNESS_MAX_STEPS", async () => {
    const conditions = createHarnessStopConditions();
    expect(conditions).toHaveLength(1);

    const [condition] = conditions;
    const completedSteps = (n: number) =>
      Array.from({ length: n }, () => ({}));

    expect(
      await condition({ steps: completedSteps(HARNESS_MAX_STEPS - 1) } as never)
    ).toBe(false);
    expect(
      await condition({ steps: completedSteps(HARNESS_MAX_STEPS) } as never)
    ).toBe(true);
  });
});

// --- Prepare-step policy ---

describe("createHarnessPrepareStep", () => {
  const baseArgs = {
    instructions: "ORIGINAL PROMPT",
  };

  it("returns exactly {} for every non-final step, even after tool calls", async () => {
    const prepareStep = createHarnessPrepareStep();

    for (let stepNumber = 0; stepNumber <= HARNESS_MAX_STEPS - 2; stepNumber++) {
      const result = await prepareStep({
        stepNumber,
        instructions: "ORIGINAL PROMPT",
        // Previous steps emitted tool calls; the policy must not react.
        steps: [{ toolCalls: [{ toolName: "bash" }] }],
      } as never);

      expect(result).toEqual({});
      // Explicitly: the chat policy's levers must never appear.
      expect(result).not.toHaveProperty("activeTools");
      expect(result).not.toHaveProperty("temperature");
      expect(result).not.toHaveProperty("model");
    }
  });

  it("forces a text wrap-up on the final permitted step (string instructions)", async () => {
    const prepareStep = createHarnessPrepareStep();
    const result = await prepareStep({
      stepNumber: HARNESS_MAX_STEPS - 1,
      instructions: "ORIGINAL PROMPT",
    } as never);

    expect(result).toMatchObject({ toolChoice: "none" });
    const instructions = result?.instructions;
    expect(typeof instructions).toBe("string");
    expect(instructions).toContain("ORIGINAL PROMPT");
    expect(instructions).toContain("maximum number of steps");
    expect(instructions).toContain("Do not call any more tools");
  });

  it("keeps array instructions and appends the wrap-up message", async () => {
    const prepareStep = createHarnessPrepareStep();
    const base = [{ role: "system" as const, content: "ORIGINAL PROMPT" }];
    const result = await prepareStep({
      stepNumber: HARNESS_MAX_STEPS - 1,
      instructions: base,
    } as never);

    expect(result).toMatchObject({ toolChoice: "none" });
    const instructions = result?.instructions;
    expect(Array.isArray(instructions)).toBe(true);
    const arr = instructions as Array<{ role: string; content: string }>;
    expect(arr[0]).toEqual(base[0]);
    expect(arr).toHaveLength(2);
    expect(arr[1].content).toContain("maximum number of steps");
  });

  it("handles undefined base instructions", async () => {
    const prepareStep = createHarnessPrepareStep();
    const result = await prepareStep({
      stepNumber: HARNESS_MAX_STEPS - 1,
      instructions: undefined,
    } as never);

    expect(result).toMatchObject({ toolChoice: "none" });
    const instructions = result?.instructions;
    expect(instructions).toBeDefined();
    expect(instructions).toMatchObject({ role: "system" });
    expect((instructions as { content: string }).content).toContain(
      "maximum number of steps"
    );
  });

  it("uses the shared HARNESS_MAX_STEPS constant as its boundary", async () => {
    const prepareStep = createHarnessPrepareStep();
    expect(
      await prepareStep({
        stepNumber: HARNESS_MAX_STEPS - 2,
        ...baseArgs,
      } as never)
    ).toEqual({});
    expect(
      await prepareStep({
        stepNumber: HARNESS_MAX_STEPS - 1,
        ...baseArgs,
      } as never)
    ).toMatchObject({ toolChoice: "none" });
  });
});

// --- Timeout invariants ---

describe("HARNESS_TIMEOUT invariants", () => {
  it("orders the aggregate timeouts and keeps bash inside its SDK timeout", () => {
    expect(HARNESS_TIMEOUT.totalMs).toBeGreaterThan(HARNESS_TIMEOUT.stepMs);
    expect(HARNESS_TIMEOUT.stepMs).toBeGreaterThan(HARNESS_TIMEOUT.firstChunkMs);
    expect(HARNESS_TIMEOUT.tools.bashMs).toBeGreaterThan(
      HARNESS_BASH_TIMEOUT_MS
    );
    expect(HARNESS_BASH_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});

// --- End-to-end loop behavior with a scripted model (B1) ---

describe("harness loop end-to-end (scripted model)", () => {
  it("keeps bash available every step and forces a final text wrap-up", async () => {
    const bashTool = tool({
      description: "Run a shell command.",
      inputSchema: z.object({ command: z.string() }),
      execute: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });

    const tools: ToolSet = { bash: bashTool };

    const model = new MockLanguageModelV4({
      provider: "test",
      modelId: "scripted-model",
      doStream: async (options) => {
        // The provider-facing call options expose toolChoice and tools.
        const toolChoice = options.toolChoice;
        const forcesText =
          typeof toolChoice === "object" &&
          toolChoice !== null &&
          "type" in toolChoice &&
          (toolChoice as { type?: unknown }).type === "none";

        if (forcesText) {
          return {
            stream: simulateReadableStream({
              chunks: [
                makeStreamStart(),
                makeTextStart(),
                makeTextDelta("Final status report."),
                makeTextEnd(),
                makeFinish("stop"),
              ],
            }),
          };
        }

        return {
          stream: simulateReadableStream({
            chunks: [
              makeStreamStart(),
              makeToolInputStart("call-1", "bash"),
              makeToolInputDelta("call-1", '{"command":"echo ok"}'),
              makeToolInputEnd("call-1"),
              makeToolCall("call-1", "bash", '{"command":"echo ok"}'),
              makeFinish("tool-calls"),
            ],
          }),
        };
      },
    });

    const result = createHarnessLoop({
      model,
      tools,
      instructions: "PROJECT PROMPT",
      messages: [{ role: "user", content: "do the work" }],
      stopWhen: createHarnessStopConditions(),
      prepareStep: createHarnessPrepareStep(),
      timeout: HARNESS_TIMEOUT,
    });

    const text = await result.text;

    // 1. Exactly HARNESS_MAX_STEPS model invocations.
    expect(model.doStreamCalls).toHaveLength(HARNESS_MAX_STEPS);

    // 2. bash is offered to the provider on every step before the final one.
    for (let i = 0; i <= HARNESS_MAX_STEPS - 2; i++) {
      const call = model.doStreamCalls[i];
      const offered = (call.tools ?? []).map((t) => t.name);
      expect(offered).toContain("bash");
      // 3. No temperature override on any call.
      expect(call.temperature).toBeUndefined();
    }

    // 4. The final invocation forces text: toolChoice none + prompt intact.
    const lastCall = model.doStreamCalls[HARNESS_MAX_STEPS - 1];
    expect(lastCall.toolChoice).toMatchObject({ type: "none" });
    expect(JSON.stringify(lastCall.prompt)).toContain("PROJECT PROMPT");
    expect(lastCall.temperature).toBeUndefined();

    // 5. The run ends with the wrap-up text.
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain("Final status report.");
    expect(syslog).toBeDefined();
  }, 30_000);
});
