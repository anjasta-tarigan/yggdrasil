export type ReasoningEffortTier = "xhigh" | "high" | "medium" | "low";

export function getReasoningProviderOptions(
  modelId: string,
  requestedEffort: ReasoningEffortTier = "xhigh"
): Record<string, unknown> {
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
