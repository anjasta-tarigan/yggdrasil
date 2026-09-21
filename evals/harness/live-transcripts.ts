/**
 * Builds raw SSE transcripts (the exact wire format the Projects chat route
 * emits) for the offline tests of the live scenarios.
 *
 * Chunk order follows the AI-SDK `toUIMessageStream` shape:
 *   start -> (start-step -> [tool chunks | text chunks] -> finish-step)* ->
 *   message-metadata -> [error] -> finish -> [DONE]
 */

export interface TranscriptTool {
  name: string;
  input: unknown;
  /** The tool result. Omit when `errorText` is set. */
  output?: unknown;
  /** Emits a `tool-output-error` chunk instead of an output. */
  errorText?: string;
}

export interface TranscriptStep {
  tools?: TranscriptTool[];
  text?: string;
}

export interface TranscriptOptions {
  /** Emits a stream `error` chunk before `finish`. */
  streamError?: string;
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

export function buildTranscript(
  steps: TranscriptStep[],
  options: TranscriptOptions = {}
): string {
  const out: string[] = [frame({ type: "start", messageId: "pmsg_eval" })];
  let callCounter = 0;
  let textCounter = 0;
  for (const step of steps) {
    out.push(frame({ type: "start-step" }));
    for (const tool of step.tools ?? []) {
      callCounter += 1;
      const toolCallId = `tc_${callCounter}`;
      out.push(frame({ type: "tool-input-start", toolCallId, toolName: tool.name }));
      out.push(
        frame({
          type: "tool-input-available",
          toolCallId,
          toolName: tool.name,
          input: tool.input,
        })
      );
      if (tool.errorText !== undefined) {
        out.push(
          frame({
            type: "tool-output-error",
            toolCallId,
            toolName: tool.name,
            errorText: tool.errorText,
          })
        );
      } else {
        out.push(
          frame({
            type: "tool-output-available",
            toolCallId,
            toolName: tool.name,
            output: tool.output ?? {},
          })
        );
      }
    }
    if (step.text) {
      textCounter += 1;
      const id = `t${textCounter}`;
      out.push(frame({ type: "text-start", id }));
      out.push(frame({ type: "text-delta", id, delta: step.text }));
      out.push(frame({ type: "text-end", id }));
    }
    out.push(frame({ type: "finish-step", finishReason: step.tools?.length ? "tool-calls" : "stop" }));
  }
  out.push(frame({ type: "message-metadata", messageMetadata: { reasoningEffort: "high" } }));
  if (options.streamError !== undefined) {
    out.push(frame({ type: "error", errorText: options.streamError }));
  }
  out.push(frame({ type: "finish", finishReason: "stop" }));
  out.push("data: [DONE]\n");
  return out.join("\n");
}
