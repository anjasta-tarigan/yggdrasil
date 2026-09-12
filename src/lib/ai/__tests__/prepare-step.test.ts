import { describe, it, expect } from "vitest";
import { createPrepareStep, type PrepareStepArgs } from "@/lib/ai/prepare-step";
import type { LanguageModel, StepResult } from "ai";

// ── Fixtures ────────────────────────────────────────────────────────

const TEST_MODEL = { provider: "test", modelId: "test-model" } as LanguageModel;

/** Build a minimal StepResult with the given tool-call names. */
function makeStep(toolNames: string[]): StepResult {
  return {
    stepNumber: 0,
    toolCalls: toolNames.map((name) => ({
      type: "tool-call" as const,
      toolCallId: `call-${name}`,
      toolName: name,
      input: {},
    })),
  } as unknown as StepResult;
}

/**
 * Build the args object that the AI SDK hands to a prepareStep callback.
 * Only `steps` and `stepNumber` are consumed by the implementation; the
 * remaining fields are stubbed so the object is structurally complete.
 */
function makeArgs(stepNumber: number, steps: StepResult[]): PrepareStepArgs {
  return {
    steps,
    stepNumber,
    model: TEST_MODEL,
    instructions: undefined,
    initialInstructions: undefined,
    messages: [],
    initialMessages: [],
    responseMessages: [],
    toolsContext: {} as never,
    runtimeContext: {},
  } as PrepareStepArgs;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("createPrepareStep", () => {
  describe("baseline (no adaptation)", () => {
    it("returns an empty object at step 0 with no tool calls", async () => {
      const prepareStep = createPrepareStep({
        availableToolNames: ["web_search", "bash"],
      });
      const result = await prepareStep(makeArgs(0, []));
      expect(result).toEqual({});
    });

    it("returns an empty object at step 3 with no tool calls (below threshold)", async () => {
      const prepareStep = createPrepareStep({
        availableToolNames: ["web_search", "bash"],
      });
      const result = await prepareStep(
        makeArgs(3, [makeStep(["web_search"])]),
      );
      expect(result).toEqual({});
    });

    it("returns an empty object at step 4 with tool calls but below threshold", async () => {
      const prepareStep = createPrepareStep({
        availableToolNames: ["web_search", "bash"],
      });
      const result = await prepareStep(
        makeArgs(4, [makeStep(["web_search"])]),
      );
      expect(result).toEqual({});
    });
  });

  describe("adaptation above threshold", () => {
    it("at step 5 with tool calls returns focused temperature", async () => {
      const prepareStep = createPrepareStep();
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search", "bash"])]),
      );
      expect(result?.temperature).toBe(0.1);
    });

    it("at step 5 with tool calls sets activeTools excluding withheld tools", async () => {
      const prepareStep = createPrepareStep({
        availableToolNames: ["web_search", "bash", "reminder_schedule"],
      });
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search", "bash"])]),
      );
      expect(result?.temperature).toBe(0.1);
      expect(result?.activeTools).toEqual(["web_search", "reminder_schedule"]);
    });

    it("does not set activeTools when availableToolNames is not provided", async () => {
      const prepareStep = createPrepareStep();
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search", "bash"])]),
      );
      expect(result?.activeTools).toBeUndefined();
    });
  });

  describe("reasoningModel override", () => {
    it("sets model when reasoningModel is provided", async () => {
      const mockModel = {
        provider: "test",
        modelId: "o1-preview",
      } as LanguageModel;
      const prepareStep = createPrepareStep({ reasoningModel: mockModel });
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search"])]),
      );
      expect(result?.model).toBe(mockModel);
      expect(result?.temperature).toBe(0.1);
    });

    it("omits model when reasoningModel is not provided", async () => {
      const prepareStep = createPrepareStep();
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search"])]),
      );
      expect(result?.model).toBeUndefined();
    });
  });

  describe("custom options", () => {
    it("custom threshold triggers adaptation earlier", async () => {
      const prepareStep = createPrepareStep({ temperatureStepThreshold: 3 });
      const result = await prepareStep(
        makeArgs(3, [makeStep(["web_search"])]),
      );
      expect(result?.temperature).toBe(0.1);
    });

    it("custom threshold=3 does not trigger at step 2", async () => {
      const prepareStep = createPrepareStep({ temperatureStepThreshold: 3 });
      const result = await prepareStep(
        makeArgs(2, [makeStep(["web_search"])]),
      );
      expect(result).toEqual({});
    });

    it("custom withheldToolNames excludes the specified tool", async () => {
      const prepareStep = createPrepareStep({
        withheldToolNames: ["web_search"],
        availableToolNames: ["web_search", "bash", "reminder_schedule"],
      });
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search"])]),
      );
      expect(result?.activeTools).toEqual(["bash", "reminder_schedule"]);
    });

    it("custom focusedTemperature is used in the result", async () => {
      const prepareStep = createPrepareStep({ focusedTemperature: 0.5 });
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search"])]),
      );
      expect(result?.temperature).toBe(0.5);
    });

    it("empty withheldToolNames keeps all tools", async () => {
      const prepareStep = createPrepareStep({
        withheldToolNames: [],
        availableToolNames: ["web_search", "bash"],
      });
      const result = await prepareStep(
        makeArgs(5, [makeStep(["web_search"])]),
      );
      expect(result?.activeTools).toEqual(["web_search", "bash"]);
    });
  });
});
