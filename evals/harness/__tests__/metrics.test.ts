import { describe, it, expect } from "vitest";
import { computeMetrics, buildToolCalls, findRepeatedToolCalls } from "../metrics";
import { parseUiMessageStream } from "../parse-stream";
import {
  TRANSCRIPT_AGENTIC_SUCCESS,
  TRANSCRIPT_CHAT_FAILURE,
  TRANSCRIPT_STREAM_ERROR,
  TRANSCRIPT_RETRY_LOOP,
  TRANSCRIPT_MULTI_STEP_SUCCESS,
  TRANSCRIPT_WRONG_CONTENT,
} from "../transcripts";

describe("buildToolCalls", () => {
  it("reconstructs tool calls from input-available + output-available", () => {
    const chunks = parseUiMessageStream(TRANSCRIPT_AGENTIC_SUCCESS);
    const calls = buildToolCalls(chunks);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("file_operations");
    expect(calls[0].input).toEqual({
      action: "write",
      path: "marker.txt",
      content: "hello",
    });
    expect(calls[0].output).toEqual({
      status: "success",
      path: "marker.txt",
      bytesWritten: 5,
    });
  });

  it("records an error output when tool-output-error is present", () => {
    const sse = [
      'data: {"type":"tool-input-available","toolCallId":"tc_1","toolName":"bash","input":{"command":"ls"},"providerExecuted":false}',
      "",
      'data: {"type":"tool-output-error","toolCallId":"tc_1","errorText":"command not found"}',
      "",
      'data: [DONE]',
      "",
    ].join("\n");
    const calls = buildToolCalls(parseUiMessageStream(sse));
    expect(calls).toHaveLength(1);
    expect(calls[0].error).toBe("command not found");
    expect(calls[0].output).toBeUndefined();
  });

  it("handles output-only chunks (no prior input)", () => {
    const sse = [
      'data: {"type":"tool-output-available","toolCallId":"tc_x","toolName":"file_operations","output":{"status":"success"},"providerExecuted":true}',
      "",
      'data: [DONE]',
      "",
    ].join("\n");
    const calls = buildToolCalls(parseUiMessageStream(sse));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("file_operations");
    expect(calls[0].input).toBeUndefined();
  });
});

describe("findRepeatedToolCalls", () => {
  it("flags exact duplicates (same name + input)", () => {
    const calls = buildToolCalls(parseUiMessageStream(TRANSCRIPT_RETRY_LOOP));
    const repeated = findRepeatedToolCalls(calls);
    expect(repeated).toHaveLength(1);
    expect(repeated[0].id).toBe("tc_2");
  });

  it("does not flag calls with different inputs", () => {
    const sse = [
      'data: {"type":"tool-input-available","toolCallId":"tc_1","toolName":"file_operations","input":{"action":"write","path":"a.txt","content":"x"}}',
      "",
      'data: {"type":"tool-input-available","toolCallId":"tc_2","toolName":"file_operations","input":{"action":"write","path":"b.txt","content":"x"}}',
      "",
      'data: [DONE]',
      "",
    ].join("\n");
    const calls = buildToolCalls(parseUiMessageStream(sse));
    expect(findRepeatedToolCalls(calls)).toHaveLength(0);
  });
});

describe("computeMetrics", () => {
  it("computes correct metrics for the agentic-success transcript", () => {
    const m = computeMetrics(parseUiMessageStream(TRANSCRIPT_AGENTIC_SUCCESS));
    expect(m.steps).toBe(1);
    expect(m.toolCalls).toHaveLength(1);
    expect(m.hadError).toBe(false);
    expect(m.errorText).toBeNull();
    expect(m.finishReason).toBe("stop");
    expect(m.totalText).toBe("Wrote the marker file.");
    expect(m.usage).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(m.reasoningEffort).toBe("high");
    expect(m.erroredToolCalls).toHaveLength(0);
    expect(m.repeatedToolCalls).toHaveLength(0);
  });

  it("detects a stream error (timeout)", () => {
    const m = computeMetrics(parseUiMessageStream(TRANSCRIPT_STREAM_ERROR));
    expect(m.hadError).toBe(true);
    expect(m.errorText).toContain("timed out");
    expect(m.finishReason).toBe("error");
    expect(m.erroredToolCalls).toHaveLength(0);
  });

  it("detects a retry loop", () => {
    const m = computeMetrics(parseUiMessageStream(TRANSCRIPT_RETRY_LOOP));
    expect(m.steps).toBe(2);
    expect(m.repeatedToolCalls).toHaveLength(1);
  });

  it("reports no tool calls for chat-only failure", () => {
    const m = computeMetrics(parseUiMessageStream(TRANSCRIPT_CHAT_FAILURE));
    expect(m.toolCalls).toHaveLength(0);
    expect(m.totalText).toBe("I cannot write files.");
    expect(m.finishReason).toBe("stop");
  });

  it("counts two steps for multi-step success", () => {
    const m = computeMetrics(parseUiMessageStream(TRANSCRIPT_MULTI_STEP_SUCCESS));
    expect(m.steps).toBe(2);
    expect(m.toolCalls).toHaveLength(2);
    expect(m.toolCalls[0].name).toBe("file_operations");
    expect(m.toolCalls[1].name).toBe("file_operations");
  });

  it("exposes the wrong-content tool call input", () => {
    const m = computeMetrics(parseUiMessageStream(TRANSCRIPT_WRONG_CONTENT));
    expect(m.toolCalls[0].input).toEqual({
      action: "write",
      path: "marker.txt",
      content: "world",
    });
  });

  it("treats an abort chunk as an error", () => {
    const sse = [
      'data: {"type":"abort","reason":"user cancelled"}',
      "",
      'data: [DONE]',
      "",
    ].join("\n");
    const m = computeMetrics(parseUiMessageStream(sse));
    expect(m.hadError).toBe(true);
    expect(m.errorText).toBe("user cancelled");
  });
});
