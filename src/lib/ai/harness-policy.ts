// Node:fs-free harness policy for the durable workflow.
//
// This mirrors the pure parts of `@/lib/ai/harness-loop` (which the durable
// workflow CANNOT import: it pulls `log-store` via `syslog`, and the Workflow
// runtime forbids Node.js modules in the workflow-function bundle). The route
// keeps the full policy (with logging); this module provides the same step-cap
// and context-guard behaviour without the `syslog` side effects, so the durable
// path stays node:fs-free while remaining behaviourally equivalent.

import {
  type Instructions,
  type ModelMessage,
  type PrepareStepFunction,
  type SystemModelMessage,
  type ToolSet,
} from "ai";
import { evaluateContextGuard } from "@/lib/ai/harness-context";

/** Hard cap on agent steps per turn for the project harness. */
export const HARNESS_MAX_STEPS = 60;

export type HarnessStopReason =
  | "natural"
  | "step-cap"
  | "context-wrap-up"
  | "output-cap"
  | "content-filter"
  | "error";

/** Inputs for {@link harnessStopReason}. */
export interface HarnessStopReasonInput {
  steps: number;
  finishReason: string;
  contextWrapUp: boolean;
}

/**
 * Classifies a completed turn for the client. Mirrors the route's classifier.
 */
export function harnessStopReason(
  input: HarnessStopReasonInput
): HarnessStopReason {
  if (input.contextWrapUp) return "context-wrap-up";
  if (input.steps >= HARNESS_MAX_STEPS) return "step-cap";
  if (input.finishReason === "length") return "output-cap";
  if (input.finishReason === "content-filter") return "content-filter";
  if (input.finishReason === "error") return "error";
  return "natural";
}

/** Options for {@link createHarnessPrepareStep}. */
export interface HarnessPrepareStepOptions {
  contextBudgetTokens?: number;
  onContextGuard?: (event: {
    action: "elide" | "wrap-up";
    elidedCount?: number;
    prunedReasoning?: boolean;
    tokensBefore?: number;
    tokensAfter: number;
  }) => void;
}

const HARNESS_WRAP_UP_INSTRUCTION =
  "You have reached the maximum number of steps for this turn. Do not call any more tools. Write a brief status report: what is done, what remains, and the exact next step the user should request.";

const HARNESS_CONTEXT_WRAP_UP_INSTRUCTION =
  "The context window is nearly full. Do not call any more tools. Write a brief status report: what is done, what remains, and the exact next step the user should request so the work can continue in a fresh turn.";

function appendInstruction(
  base: Instructions | undefined,
  addition: string
): Instructions {
  const extra: SystemModelMessage = { role: "system", content: addition };
  if (base === undefined) return extra;
  if (typeof base === "string") return `${base}\n\n${addition}`;
  return Array.isArray(base) ? [...base, extra] : [base, extra];
}

/**
 * Prepare-step policy for the durable harness. Behaviourally identical to the
 * route's `createHarnessPrepareStep` except it does not call `syslog` (which
 * would pull `log-store`/`node:fs` into the workflow bundle). On the final
 * permitted step it forces a text wrap-up; with a context budget it runs the
 * in-run context guard from `@/lib/ai/harness-context` (node:fs-free).
 */
export function createHarnessPrepareStep(
  options?: HarnessPrepareStepOptions
): PrepareStepFunction<ToolSet> {
  const contextBudgetTokens = options?.contextBudgetTokens;
  const onContextGuard = options?.onContextGuard;

  return ({ stepNumber, instructions, messages }) => {
    if (stepNumber >= HARNESS_MAX_STEPS - 1) {
      const capWrapUp: {
        toolChoice: "none";
        instructions: Instructions;
        messages?: ModelMessage[];
      } = {
        toolChoice: "none",
        instructions: appendInstruction(
          instructions,
          HARNESS_WRAP_UP_INSTRUCTION
        ),
      };
      if (contextBudgetTokens !== undefined) {
        const decision = evaluateContextGuard({
          messages,
          budgetTokens: contextBudgetTokens,
          stepNumber,
        });
        if (decision.action === "elide") {
          capWrapUp.messages = decision.messages;
          onContextGuard?.({
            action: "elide",
            elidedCount: decision.elidedCount,
            prunedReasoning: decision.prunedReasoning,
            tokensBefore: decision.tokensBefore,
            tokensAfter: decision.tokensAfter,
          });
        } else if (decision.action === "wrap-up") {
          if (decision.messages) capWrapUp.messages = decision.messages;
          onContextGuard?.({
            action: "wrap-up",
            tokensAfter: decision.tokensAfter,
          });
        }
      }
      return capWrapUp;
    }

    if (contextBudgetTokens === undefined) return {};

    const decision = evaluateContextGuard({
      messages,
      budgetTokens: contextBudgetTokens,
      stepNumber,
    });

    if (decision.action === "none") return {};

    if (decision.action === "elide") {
      onContextGuard?.({
        action: "elide",
        elidedCount: decision.elidedCount,
        prunedReasoning: decision.prunedReasoning,
        tokensBefore: decision.tokensBefore,
        tokensAfter: decision.tokensAfter,
      });
      return { messages: decision.messages };
    }

    onContextGuard?.({
      action: "wrap-up",
      tokensAfter: decision.tokensAfter,
    });
    const contextWrapUp: {
      toolChoice: "none";
      instructions: Instructions;
      messages?: ModelMessage[];
    } = {
      toolChoice: "none",
      instructions: appendInstruction(
        instructions,
        HARNESS_CONTEXT_WRAP_UP_INSTRUCTION
      ),
    };
    if (decision.messages) {
      contextWrapUp.messages = decision.messages;
    }
    return contextWrapUp;
  };
}
