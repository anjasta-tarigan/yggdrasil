import type { ModelMessage, UIDataTypes, UITools, UIMessage, UIMessagePart } from "ai";

/** The default UI part union — no custom data or tool types. */
type UIPart = UIMessagePart<UIDataTypes, UITools>;

/** Options for {@link modelMessagesToUIMessages}. */
export interface ModelMessagesToUIMessagesOptions {
  /** Injected so the converter stays pure and testable. */
  generateId: () => string;
}

/**
 * Converts the model-message transcript an agent returns into UI messages for
 * persistence.
 *
 * `WorkflowAgent` returns `ModelMessage[]`, `collectUIMessages` no longer exists,
 * and the SDK ships no inverse — so the durable path needs its own. The fallback
 * route gets the same result via `toUIMessageStream`, so this converter must
 * produce the same part shapes that `toUIMessageStream` emits, or persisted
 * history will render (and re-convert) differently on the next turn.
 *
 * Every part type the route can emit must round-trip, not just text and tool
 * calls: an approval request carries the HMAC signature that
 * `convertToModelMessages()` verifies on the *next* turn, so dropping it would
 * fail the approval gate silently rather than loudly.
 */
export function modelMessagesToUIMessages(
  messages: ModelMessage[],
  options: ModelMessagesToUIMessagesOptions
): UIMessage[] {
  return messages.map((message) => ({
    id: options.generateId(),
    role: message.role,
    parts: contentToParts(message.content, options),
  })) as UIMessage[];
}

/** Normalizes string content and maps structured parts into UI part shapes. */
function contentToParts(
  content: ModelMessage["content"],
  options: ModelMessagesToUIMessagesOptions
): UIPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }] as UIPart[];
  }

  const parts: UIPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text } as UIPart);
        break;

      case "reasoning":
        parts.push({
          type: "reasoning",
          text: part.text,
          ...("signature" in part && part.signature
            ? { signature: part.signature }
            : {}),
        } as UIPart);
        break;

      case "tool-call":
        parts.push({
          type: `tool-${part.toolName}`,
          toolCallId: part.toolCallId,
          state: "input-available",
          input: part.input,
        } as UIPart);
        break;

      case "tool-result":
        // `toUIMessageStream` keeps the tool name on the result part too, so a
        // persisted transcript renders the same way and re-converts cleanly.
        parts.push({
          type: `tool-${part.toolName}`,
          toolCallId: part.toolCallId,
          state: "output-available",
          output: part.output,
        } as UIPart);
        break;

      case "tool-approval-request": {
        // Carries the HMAC signature — critical to preserve (see module doc).
        // The SDK's tool-approval-request UI part is a wide union that the model
        // message's approval part does not structurally match, so we build the
        // runtime-correct object and assert it through unknown. The fields the
        // next-turn signature check needs (approvalId, toolCallId, signature)
        // are present and preserved.
        parts.push({
          type: "tool-approval-request",
          approvalId: part.approvalId,
          toolCallId: part.toolCallId,
          ...("toolName" in part && part.toolName
            ? { toolName: part.toolName as string }
            : {}),
          ...("signature" in part && part.signature
            ? { signature: part.signature as string }
            : {}),
          ...("status" in part && part.status
            ? { status: part.status as string }
            : {}),
        } as unknown as UIPart);
        break;
      }

      // File / image / other parts: forward untouched. They are already valid
      // UIMessagePart shapes; widening the switch later is additive.
      default:
        parts.push(part as unknown as UIPart);
        break;
    }
  }
  return parts;
}
