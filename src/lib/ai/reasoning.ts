export type ReasoningEffortTier = "xhigh" | "high" | "medium" | "low" | "none";

export const TARGET_THINKING_BUDGETS: Record<ReasoningEffortTier, number> = {
  xhigh: 32_000,
  high: 16_000,
  medium: 8_000,
  low: 2_000,
  none: 0,
};

export const MIN_THINKING_BUDGET = 1_024;

export function calculateReasoningOutputBudget(
  effort: ReasoningEffortTier,
  modelMaxOutput: number | null | undefined
): { targetThinking: number; requestedOutputTokens: number } {
  const modelMax = modelMaxOutput && modelMaxOutput > 0 ? modelMaxOutput : 16_384;
  const responseFloor = Math.max(1_000, Math.min(4_000, Math.floor(modelMax * 0.25)));
  const maxThinking = Math.max(0, modelMax - responseFloor);
  const targetThinking = Math.min(TARGET_THINKING_BUDGETS[effort], maxThinking);
  const noneOutput = Math.min(4_000, modelMax);
  const requestedOutputTokens = Math.min(
    modelMax,
    Math.max(noneOutput, targetThinking + responseFloor)
  );

  return { targetThinking, requestedOutputTokens };
}

export function reconcileThinkingBudget(
  effectiveMaxOutputTokens: number,
  targetThinking: number,
  tier: ReasoningEffortTier,
  modelId: string
): {
  finalThinkingBudget: number;
  thinkingEnabled: boolean;
  providerOptions: Record<string, any>;
} {
  const clampedFloor = Math.max(
    1_000,
    Math.min(4_000, Math.floor(effectiveMaxOutputTokens * 0.25))
  );
  const reconciledThinking = Math.min(
    targetThinking,
    Math.max(0, effectiveMaxOutputTokens - clampedFloor)
  );

  const isAnthropic = modelId.toLowerCase().includes("claude");
  const isOpenAiReasoning =
    modelId.toLowerCase().startsWith("o1") ||
    modelId.toLowerCase().startsWith("o3") ||
    modelId.toLowerCase().includes("reasoning");

  if (tier === "none" || reconciledThinking < MIN_THINKING_BUDGET) {
    let providerOptions: Record<string, any>;
    if (isAnthropic) {
      providerOptions = { anthropic: { thinking: { type: "disabled" } } };
    } else if (isOpenAiReasoning) {
      providerOptions = { openai: { reasoningEffort: "low" } };
    } else {
      providerOptions = {};
    }

    return {
      finalThinkingBudget: 0,
      thinkingEnabled: false,
      providerOptions,
    };
  }

  const finalThinkingBudget = reconciledThinking;
  const thinkingEnabled = true;
  let providerOptions: Record<string, any>;

  if (isAnthropic) {
    providerOptions = {
      anthropic: {
        thinking: { type: "enabled", budgetTokens: finalThinkingBudget },
      },
    };
  } else if (isOpenAiReasoning) {
    providerOptions = {
      openai: {
        reasoningEffort: tier === "xhigh" ? "high" : tier,
      },
    };
  } else {
    // Open-weight / custom vLLM passthrough
    providerOptions = {
      openai: {
        reasoningEffort: tier === "xhigh" ? "high" : tier,
      },
    };
  }

  return {
    finalThinkingBudget,
    thinkingEnabled,
    providerOptions,
  };
}

export function getReasoningProviderOptions(
  modelId: string,
  requestedEffort: ReasoningEffortTier = "xhigh"
): Record<string, any> {
  const isAnthropic = modelId.toLowerCase().includes("claude");
  const isOpenAiReasoning =
    modelId.toLowerCase().startsWith("o1") ||
    modelId.toLowerCase().startsWith("o3") ||
    modelId.toLowerCase().includes("reasoning");

  if (isOpenAiReasoning) {
    const oaiEffort = requestedEffort === "xhigh" ? "high" : requestedEffort;
    return {
      openai: { reasoningEffort: oaiEffort },
    };
  }

  if (isAnthropic) {
    const budgetTokens =
      requestedEffort === "xhigh"
        ? 16000
        : requestedEffort === "high"
          ? 8000
          : requestedEffort === "medium"
            ? 4000
            : 2048;
    return {
      anthropic: {
        thinking: { type: "enabled", budgetTokens },
      },
    };
  }

  // Open-weight / custom vLLM passthrough
  return {
    openai: {
      reasoningEffort: requestedEffort === "xhigh" ? "high" : requestedEffort,
    },
  };
}

export function extractThinkTags(rawText: string): { reasoning: string | null; text: string } {
  const match = rawText.match(/<think>([\s\S]*?)<\/think>/);
  if (!match) {
    return { reasoning: null, text: rawText };
  }
  const reasoning = match[1].trim();
  const text = rawText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { reasoning, text };
}

export function createThinkTagStreamTransformer(): TransformStream<any, any> {
  let insideThink = false;
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type !== "text-delta" || typeof chunk.text !== "string") {
        controller.enqueue(chunk);
        return;
      }

      buffer += chunk.text;

      while (buffer.length > 0) {
        if (!insideThink) {
          const thinkStart = buffer.indexOf("<think>");
          if (thinkStart === -1) {
            // Check for partial '<think' at the end of buffer
            const partialIndex = buffer.lastIndexOf("<");
            if (partialIndex !== -1 && "<think>".startsWith(buffer.slice(partialIndex))) {
              const safeText = buffer.slice(0, partialIndex);
              if (safeText) controller.enqueue({ type: "text-delta", text: safeText });
              buffer = buffer.slice(partialIndex);
              break;
            }
            controller.enqueue({ type: "text-delta", text: buffer });
            buffer = "";
            break;
          }

          const before = buffer.slice(0, thinkStart);
          if (before) controller.enqueue({ type: "text-delta", text: before });
          insideThink = true;
          buffer = buffer.slice(thinkStart + "<think>".length);
        } else {
          const thinkEnd = buffer.indexOf("</think>");
          if (thinkEnd === -1) {
            const partialIndex = buffer.lastIndexOf("<");
            if (partialIndex !== -1 && "</think>".startsWith(buffer.slice(partialIndex))) {
              const safeReasoning = buffer.slice(0, partialIndex);
              if (safeReasoning) controller.enqueue({ type: "reasoning", text: safeReasoning });
              buffer = buffer.slice(partialIndex);
              break;
            }
            controller.enqueue({ type: "reasoning", text: buffer });
            buffer = "";
            break;
          }

          const reasoning = buffer.slice(0, thinkEnd);
          if (reasoning) controller.enqueue({ type: "reasoning", text: reasoning });
          insideThink = false;
          buffer = buffer.slice(thinkEnd + "</think>".length);
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        if (insideThink) {
          controller.enqueue({ type: "reasoning", text: buffer });
        } else {
          controller.enqueue({ type: "text-delta", text: buffer });
        }
        buffer = "";
      }
    },
  });
}
