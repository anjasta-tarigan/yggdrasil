/**
 * Aggregates parsed UI-message chunks into {@link RunMetrics}.
 *
 * The metrics are derived *only* from the transcript — they describe what the
 * model streamed, not what the judge ultimately decides. The judge combines
 * these signals with on-disk ground truth (Spec §3.1).
 */
import type {
  ToolCall,
  RunMetrics,
  UiMessageChunk,
  ToolInputAvailableChunk,
  ToolOutputAvailableChunk,
  ToolOutputErrorChunk,
  MessageMetadataChunk,
} from "./contracts";

function isToolInputAvailable(
  c: UiMessageChunk
): c is ToolInputAvailableChunk {
  return c.type === "tool-input-available";
}
function isToolOutputAvailable(
  c: UiMessageChunk
): c is ToolOutputAvailableChunk {
  return c.type === "tool-output-available";
}
function isToolOutputError(
  c: UiMessageChunk
): c is ToolOutputErrorChunk {
  return c.type === "tool-output-error";
}
function isMessageMetadata(c: UiMessageChunk): c is MessageMetadataChunk {
  return c.type === "message-metadata";
}

/**
 * Reconstructs the full ordered list of tool calls and their results from a
 * transcript.
 *
 * `tool-input-available` carries the complete tool input (the AI-SDK emits
 * the assembled input rather than requiring the harness to stitch together
 * `tool-input-start` + `tool-input-delta` fragments). Outputs are matched by
 * `toolCallId`.
 */
export function buildToolCalls(chunks: UiMessageChunk[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  const order: string[] = [];

  for (const chunk of chunks) {
    if (isToolInputAvailable(chunk)) {
      if (!byId.has(chunk.toolCallId)) {
        order.push(chunk.toolCallId);
      }
      byId.set(chunk.toolCallId, {
        id: chunk.toolCallId,
        name: chunk.toolName,
        input: chunk.input,
        providerExecuted: chunk.providerExecuted,
      });
      continue;
    }

    if (isToolOutputAvailable(chunk)) {
      const existing = byId.get(chunk.toolCallId);
      if (existing) {
        existing.output = chunk.output;
        existing.providerExecuted = chunk.providerExecuted ?? existing.providerExecuted;
      } else {
        const synthetic: ToolCall = {
          id: chunk.toolCallId,
          name: chunk.toolName,
          input: undefined,
          output: chunk.output,
          providerExecuted: chunk.providerExecuted,
        };
        order.push(chunk.toolCallId);
        byId.set(chunk.toolCallId, synthetic);
      }
      continue;
    }


    if (isToolOutputError(chunk)) {
      const existing = byId.get(chunk.toolCallId);
      if (existing) {
        existing.error = chunk.errorText;
      } else {
        const synthetic: ToolCall = {
          id: chunk.toolCallId,
          name: chunk.toolName,
          input: undefined,
          error: chunk.errorText,
        };
        order.push(chunk.toolCallId);
        byId.set(chunk.toolCallId, synthetic);
      }
      continue;
    }
  }

  return order.map((id) => byId.get(id)!);
}

/**
 * Detects tool calls that are exact duplicates — same name and same serialized
 * input. This is the signature of a retry loop where the agent re-issues a
 * call the provider already executed (or failed on) without incorporating
 * the result.
 */
export function findRepeatedToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const seen = new Map<string, ToolCall>();
  const repeated: ToolCall[] = [];
  for (const call of toolCalls) {
    const key = `${call.name}:${JSON.stringify(call.input)}`;
    if (seen.has(key)) {
      repeated.push(call);
    } else {
      seen.set(key, call);
    }
  }
  return repeated;
}

/**
 * Computes aggregate metrics from a parsed transcript.
 */
export function computeMetrics(chunks: UiMessageChunk[]): RunMetrics {
  let steps = 0;
  let hadError = false;
  let errorText: string | null = null;
  let finishReason: string | null = null;
  let totalText = "";
  let usage: RunMetrics["usage"] = null;
  let reasoningEffort: string | null = null;

  for (const chunk of chunks) {
    if (chunk.type === "start-step") steps++;
    if (chunk.type === "error" || chunk.type === "abort") {
      hadError = true;
      if (chunk.type === "error") {
        errorText = chunk.errorText;
      } else if (chunk.reason) {
        errorText = chunk.reason;
      }
    }
    if (chunk.type === "finish" && chunk.finishReason) {
      finishReason = chunk.finishReason;
    }
    if (chunk.type === "text-delta") {
      totalText += chunk.delta;
    }
    if (isMessageMetadata(chunk)) {
      const md = chunk.messageMetadata;
      if (md.usage) {
        usage = {
          inputTokens: md.usage.inputTokens ?? 0,
          outputTokens: md.usage.outputTokens ?? 0,
          totalTokens: md.usage.totalTokens ?? 0,
        };
      }
      if (md.reasoningEffort) {
        reasoningEffort = md.reasoningEffort;
      }
    }
  }

  const toolCalls = buildToolCalls(chunks);
  const erroredToolCalls = toolCalls.filter((c) => c.error !== undefined);
  const repeatedToolCalls = findRepeatedToolCalls(toolCalls);

  return {
    steps,
    toolCalls,
    erroredToolCalls,
    hadError,
    errorText,
    finishReason,
    totalText,
    usage,
    reasoningEffort,
    repeatedToolCalls,
  };
}
