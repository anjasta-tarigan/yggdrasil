import { describe, it, expect } from "vitest";
import { createChatStopConditions } from "@/lib/ai/termination-conditions";
import type { StopCondition, ToolSet } from "ai";

/**
 * Minimal mock StepResult — only the fields that the stop conditions
 * actually inspect are provided.  `isStepCount` reads `steps.length`;
 * `hasToolCall` reads `steps[last].toolCalls[].toolName`.
 */
function makeStep(toolCalls: Array<{ toolName: string }> = []) {
  return { toolCalls } as unknown as Parameters<StopCondition<ToolSet, Record<string, never>>>[0]["steps"][number];
}

/** Build an array of `n` empty steps (no tool calls). */
function makeSteps(n: number) {
  return Array.from({ length: n }, () => makeStep());
}

describe("createChatStopConditions", () => {
  it("returns an array of exactly 2 stop conditions", () => {
    const conditions = createChatStopConditions();
    expect(Array.isArray(conditions)).toBe(true);
    expect(conditions).toHaveLength(2);
    expect(conditions.every(c => typeof c === "function")).toBe(true);
  });

  describe("isStepCount(15) condition", () => {
    const stepCountCondition = createChatStopConditions()[0] as StopCondition<
      ToolSet,
      Record<string, never>
    >;

    it("stops at exactly 15 steps", () => {
      const steps = makeSteps(15);
      expect(stepCountCondition({ steps })).toBe(true);
    });

    it("does not stop at 14 steps", () => {
      const steps = makeSteps(14);
      expect(stepCountCondition({ steps })).toBe(false);
    });

    it("does not stop below the cap", () => {
      const steps = makeSteps(1);
      expect(stepCountCondition({ steps })).toBe(false);
    });
  });

  describe("hasToolCall('ask_user_question') condition", () => {
    const toolCallCondition = createChatStopConditions()[1] as StopCondition<
      ToolSet,
      Record<string, never>
    >;

    it("stops when the last step has a tool call named 'ask_user_question'", () => {
      const steps = [makeStep(), makeStep([{ toolName: "ask_user_question" }])];
      expect(toolCallCondition({ steps })).toBe(true);
    });

    it("does not stop when the last step has no tool calls", () => {
      const steps = makeSteps(3);
      expect(toolCallCondition({ steps })).toBe(false);
    });

    it("does not stop when the last step has a different tool call", () => {
      const steps = [makeStep([{ toolName: "bash" }])];
      expect(toolCallCondition({ steps })).toBe(false);
    });

    it("only inspects the last step — an earlier ask_user_question does not trigger", () => {
      // Per AI SDK semantics hasToolCall checks steps[steps.length - 1] only.
      const steps = [
        makeStep([{ toolName: "ask_user_question" }]),
        makeStep([{ toolName: "bash" }]),
      ];
      expect(toolCallCondition({ steps })).toBe(false);
    });
  });

  describe("composite behavior (either condition triggers a stop)", () => {
    it("stops when the step count cap is reached even without ask_user_question", () => {
      const conditions = createChatStopConditions();
      const steps = makeSteps(15);
      const stopped = conditions.some(c => c({ steps }));
      expect(stopped).toBe(true);
    });

    it("stops when ask_user_question is present before hitting 15 steps", () => {
      const conditions = createChatStopConditions();
      const steps = makeSteps(7);
      steps.push(makeStep([{ toolName: "ask_user_question" }]));
      const stopped = conditions.some(c => c({ steps }));
      expect(stopped).toBe(true);
    });

    it("does not stop at step 14 with no matching tool call", () => {
      const conditions = createChatStopConditions();
      const steps = makeSteps(14);
      const stopped = conditions.some(c => c({ steps }));
      expect(stopped).toBe(false);
    });

    it("does not stop when only non-matching tool calls are present (step < 15)", () => {
      const conditions = createChatStopConditions();
      const steps = [
        makeStep([{ toolName: "bash" }]),
        makeStep([{ toolName: "memory_search" }]),
      ];
      const stopped = conditions.some(c => c({ steps }));
      expect(stopped).toBe(false);
    });
  });
});
