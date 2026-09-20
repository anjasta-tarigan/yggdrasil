/**
 * Hand-written SSE transcripts for offline evaluation.
 *
 * Each transcript is a literal SSE byte stream — exactly what the Projects
 * chat route would emit over the wire. They are authored by hand (not
 * generated) so the parser and judges are exercised against realistic,
 * end-to-end wire format rather than in-memory object graphs.
 *
 * The chunk sequence for each follows the AI-SDK `toUIMessageStream` shape:
 *   start → start-step → [tool-input-* / tool-output-* / text-*]* →
 *   finish-step → message-metadata → finish → [DONE]
 */

/** S0: agentic success — the model writes marker.txt with content "hello". */
export const TRANSCRIPT_AGENTIC_SUCCESS = [
  'data: {"type":"start","messageId":"pmsg_1"}',
  "",
  'data: {"type":"start-step"}',
  "",
  'data: {"type":"tool-input-start","toolCallId":"tc_1","toolName":"file_operations"}',
  "",
  'data: {"type":"tool-input-available","toolCallId":"tc_1","toolName":"file_operations","input":{"action":"write","path":"marker.txt","content":"hello"},"providerExecuted":false}',
  "",
  'data: {"type":"tool-output-available","toolCallId":"tc_1","output":{"status":"success","path":"marker.txt","bytesWritten":5},"providerExecuted":true}',
  "",
  'data: {"type":"finish-step","finishReason":"tool-results","usage":{"inputTokens":12,"outputTokens":8,"totalTokens":20}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":12,"outputTokens":8,"totalTokens":20},"reasoningEffort":"high"}}',
  "",
  'data: {"type":"text-start","id":"t1"}',
  "",
  'data: {"type":"text-delta","id":"t1","delta":"Wrote the marker file."}',
  "",
  'data: {"type":"text-end","id":"t1"}',
  "",
  'data: {"type":"finish","finishReason":"stop"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

/** S1: chat-like failure — the model only chats, never calls a tool. */
export const TRANSCRIPT_CHAT_FAILURE = [
  'data: {"type":"start","messageId":"pmsg_2"}',
  "",
  'data: {"type":"start-step"}',
  "",
  'data: {"type":"text-start","id":"t1"}',
  "",
  'data: {"type":"text-delta","id":"t1","delta":"I cannot write files."}',
  "",
  'data: {"type":"text-end","id":"t1"}',
  "",
  'data: {"type":"finish-step","finishReason":"stop","usage":{"inputTokens":8,"outputTokens":4,"totalTokens":12}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":8,"outputTokens":4,"totalTokens":12},"reasoningEffort":"low"}}',
  "",
  'data: {"type":"finish","finishReason":"stop"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

/** S2: stream error — the model times out and the harness emits an error chunk. */
export const TRANSCRIPT_STREAM_ERROR = [
  'data: {"type":"start","messageId":"pmsg_3"}',
  "",
  'data: {"type":"start-step"}',
  "",
  'data: {"type":"tool-input-start","toolCallId":"tc_1","toolName":"file_operations"}',
  "",
  'data: {"type":"tool-input-available","toolCallId":"tc_1","toolName":"file_operations","input":{"action":"write","path":"marker.txt","content":"hello"},"providerExecuted":false}',
  "",
  'data: {"type":"error","errorText":"The agent timed out (first chunk timeout (90000ms)). Send a follow-up message to continue."}',
  "",
  'data: {"type":"finish-step","finishReason":"error","usage":{"inputTokens":12,"outputTokens":0,"totalTokens":12}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":12,"outputTokens":0,"totalTokens":12},"reasoningEffort":"high"}}',
  "",
  'data: {"type":"finish","finishReason":"error"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

/**
 * S3: retry loop — the model re-issues the identical file_operations call
 * without incorporating the prior result, producing a duplicate tool call.
 */
export const TRANSCRIPT_RETRY_LOOP = [
  'data: {"type":"start","messageId":"pmsg_4"}',
  "",
  'data: {"type":"start-step"}',
  "",
  'data: {"type":"tool-input-start","toolCallId":"tc_1","toolName":"file_operations"}',
  "",
  'data: {"type":"tool-input-available","toolCallId":"tc_1","toolName":"file_operations","input":{"action":"write","path":"marker.txt","content":"hello"},"providerExecuted":false}',
  "",
  'data: {"type":"tool-output-available","toolCallId":"tc_1","output":{"status":"success","path":"marker.txt","bytesWritten":5},"providerExecuted":true}',
  "",
  'data: {"type":"finish-step","finishReason":"tool-results","usage":{"inputTokens":12,"outputTokens":8,"totalTokens":20}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":12,"outputTokens":8,"totalTokens":20},"reasoningEffort":"high"}}',
  "",
  'data: {"type":"start-step"}',
  "",
  // The agent re-issues the *exact same* call (same name + input).
  'data: {"type":"tool-input-available","toolCallId":"tc_2","toolName":"file_operations","input":{"action":"write","path":"marker.txt","content":"hello"},"providerExecuted":false}',
  "",
  'data: {"type":"tool-output-available","toolCallId":"tc_2","output":{"status":"success","path":"marker.txt","bytesWritten":5},"providerExecuted":true}',
  "",
  'data: {"type":"finish-step","finishReason":"tool-results","usage":{"inputTokens":12,"outputTokens":8,"totalTokens":20}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":24,"outputTokens":16,"totalTokens":40},"reasoningEffort":"high"}}',
  "",
  'data: {"type":"text-start","id":"t1"}',
  "",
  'data: {"type":"text-delta","id":"t1","delta":"Done."}',
  "",
  'data: {"type":"text-end","id":"t1"}',
  "",
  'data: {"type":"finish","finishReason":"stop"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

/** S4: multi-step agentic — read a fixture file, then write marker.txt. */
export const TRANSCRIPT_MULTI_STEP_SUCCESS = [
  'data: {"type":"start","messageId":"pmsg_5"}',
  "",
  'data: {"type":"start-step"}',
  "",
  'data: {"type":"tool-input-start","toolCallId":"tc_1","toolName":"file_operations"}',
  "",
  'data: {"type":"tool-input-available","toolCallId":"tc_1","toolName":"file_operations","input":{"action":"read","path":"note.txt"},"providerExecuted":false}',
  "",
  'data: {"type":"tool-output-available","toolCallId":"tc_1","output":{"path":"note.txt","linesCount":1,"content":"000001\tready"},"providerExecuted":true}',
  "",
  'data: {"type":"finish-step","finishReason":"tool-results","usage":{"inputTokens":10,"outputTokens":6,"totalTokens":16}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":10,"outputTokens":6,"totalTokens":16},"reasoningEffort":"high"}}',
  "",
  'data: {"type":"start-step"}',
  "",
  'data: {"type":"tool-input-available","toolCallId":"tc_2","toolName":"file_operations","input":{"action":"write","path":"marker.txt","content":"hello"},"providerExecuted":false}',
  "",
  'data: {"type":"tool-output-available","toolCallId":"tc_2","output":{"status":"success","path":"marker.txt","bytesWritten":5},"providerExecuted":true}',
  "",
  'data: {"type":"finish-step","finishReason":"tool-results","usage":{"inputTokens":10,"outputTokens":6,"totalTokens":16}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":20,"outputTokens":12,"totalTokens":32},"reasoningEffort":"high"}}',
  "",
  'data: {"type":"text-start","id":"t1"}',
  "",
  'data: {"type":"text-delta","id":"t1","delta":"Done."}',
  "",
  'data: {"type":"text-end","id":"t1"}',
  "",
  'data: {"type":"finish","finishReason":"stop"}',
  "",
  "data: [DONE]",
  "",
].join("\n");

/** S5: wrong content — the model writes marker.txt but with "world" not "hello". */
export const TRANSCRIPT_WRONG_CONTENT = [
  'data: {"type":"start","messageId":"pmsg_6"}',
  "",
  'data: {"type":"start-step"}',
  "",
  'data: {"type":"tool-input-available","toolCallId":"tc_1","toolName":"file_operations","input":{"action":"write","path":"marker.txt","content":"world"},"providerExecuted":false}',
  "",
  'data: {"type":"tool-output-available","toolCallId":"tc_1","output":{"status":"success","path":"marker.txt","bytesWritten":5},"providerExecuted":true}',
  "",
  'data: {"type":"finish-step","finishReason":"tool-results","usage":{"inputTokens":12,"outputTokens":8,"totalTokens":20}}',
  "",
  'data: {"type":"message-metadata","messageMetadata":{"usage":{"inputTokens":12,"outputTokens":8,"totalTokens":20},"reasoningEffort":"high"}}',
  "",
  'data: {"type":"text-start","id":"t1"}',
  "",
  'data: {"type":"text-delta","id":"t1","delta":"Done."}',
  "",
  'data: {"type":"text-end","id":"t1"}',
  "",
  'data: {"type":"finish","finishReason":"stop"}',
  "",
  "data: [DONE]",
  "",
].join("\n");
