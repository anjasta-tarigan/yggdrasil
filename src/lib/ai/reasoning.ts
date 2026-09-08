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
  providerOptions: Record<string, Record<string, string | number | boolean | Record<string, string | number | boolean>>>;
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
    let providerOptions: Record<string, Record<string, string | number | boolean | Record<string, string | number | boolean>>>;
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
  let providerOptions: Record<string, Record<string, string | number | boolean | Record<string, string | number | boolean>>>;

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
): Record<string, Record<string, string | number | boolean | Record<string, string | number | boolean>>> {
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

type ThinkStreamPart =
  | { type: "text-delta"; text: string }
  | { type: "reasoning"; text: string }
  | Record<string, unknown>;

export function createThinkTagStreamTransformer(): TransformStream<ThinkStreamPart, ThinkStreamPart> {
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

export type AutoReasoningContext = {
  activeTools?: string[];
  learnedRules?: string[];
  userPreferences?: string[];
};

const TIERS_ORDER: ReasoningEffortTier[] = ["none", "low", "medium", "high", "xhigh"];

const CASUAL_OR_TRANSLATE_PATTERNS = [
  /^(hi|hello|hey|howdy|greetings|thanks|thank you|good (morning|afternoon|evening))\b/i,
  /\bhow are you\b/i,
  /\b(translate\b|translation\b)/i,
];

const XHIGH_REASONING_PATTERNS = [
  /\b(race condition|deadlock|toctou|concurrency|atomic|thread safety|memory leak|mutex)\b/i,
  /\b(prove|proof|theorem|calculus|integral|combinatorics|dynamic programming)\b/i,
  /\b(security audit|vulnerability|exploit|reverse engineer|formal verification)\b/i,
  /\b(algorithmic complexity|big o|benchmark analysis)\b/i,
];

const MEDIUM_EXPLANATION_PATTERNS = [
  /\b(compare|comparison|versus|\bvs\b|difference between|pros and cons)\b/i,
  /\b(explain\s+how|explain\s+why|overview of|what is\b|walk me through)\b/i,
  /\b(review\s+this|critique\s+this)\b/i,
];

const HIGH_REASONING_PATTERNS = [
  /\b(implement|refactor|architecture|design system|custom hook|migration|database pool)\b/i,
  /\b(optimize|performance bottleneck|memory safety|debug|exception trace)\b/i,
  /\b(sql|drizzle|prisma|schema design|state machine)\b/i,
];

const LOW_REASONING_PATTERNS = [
  /\b(margin|padding|color|css|tailwind|typo|spelling|syntax|format this|rename variable)\b/i,
  /\b(add parameter|simple function|quick edit|one-liner)\b/i,
];

/**
 * Proactive task reasoning classifier with learned self-improvement hooks.
 * Analyzes query syntax, complexity, tool signals, and memory context
 * (learned procedural rules and user preferences) to select the optimal tier.
 */
export function classifyTaskReasoningEffort(
  userQuery: string,
  context?: AutoReasoningContext
): ReasoningEffortTier {
  const query = userQuery?.trim() ?? "";
  if (!query) return "none";

  // 1. Initial base tier via syntactic pattern classification
  let baseTier: ReasoningEffortTier = "medium";

  if (CASUAL_OR_TRANSLATE_PATTERNS.some((p) => p.test(query))) {
    baseTier = "none";
  } else if (XHIGH_REASONING_PATTERNS.some((p) => p.test(query))) {
    baseTier = "xhigh";
  } else if (MEDIUM_EXPLANATION_PATTERNS.some((p) => p.test(query))) {
    // Explanations/comparisons take precedence over high keywords (e.g. "Explain database pool" or "Compare Drizzle vs Prisma")
    baseTier = "medium";
  } else if (HIGH_REASONING_PATTERNS.some((p) => p.test(query))) {
    baseTier = "high";
  } else if (LOW_REASONING_PATTERNS.some((p) => p.test(query))) {
    baseTier = "low";
  }

  // Heavy tool execution signal (e.g. delegated subagents or sandbox bash) elevates minimal tiers
  if (
    baseTier === "none" &&
    context?.activeTools?.some((t) => t.startsWith("delegate_") || t === "bash")
  ) {
    baseTier = "low";
  }

  // 2. Self-Improvement Layer: evaluate learned procedural rules and preferences
  let tierIndex = TIERS_ORDER.indexOf(baseTier);

  const allRules = [
    ...(context?.learnedRules ?? []),
    ...(context?.userPreferences ?? []),
  ];

  for (const rule of allRules) {
    const rLower = rule.toLowerCase();
    // Demotion / speed signal (check negative constraints first)
    if (
      rLower.includes("fast") ||
      rLower.includes("concise") ||
      rLower.includes("without deep thinking") ||
      rLower.includes("skip reasoning") ||
      rLower.includes("no thinking") ||
      rLower.includes("fast and concise")
    ) {
      tierIndex = Math.max(1, tierIndex - 2); // lower by up to 2 tiers (e.g. high -> low)
      break;
    }

    // Elevation signal
    if (
      rLower.includes("deep reasoning") ||
      rLower.includes("maximize reasoning") ||
      rLower.includes("high reasoning") ||
      rLower.includes("deep thinking") ||
      rLower.includes("thorough analysis")
    ) {
      tierIndex = Math.min(TIERS_ORDER.length - 1, tierIndex + 1);
      break;
    }
  }

  return TIERS_ORDER[tierIndex];
}

