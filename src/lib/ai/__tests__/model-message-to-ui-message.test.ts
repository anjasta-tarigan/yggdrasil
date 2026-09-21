import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { modelMessagesToUIMessages } from "@/lib/ai/model-message-to-ui-message";

let seq = 0;
const generateId = () => `id_${++seq}`;

describe("modelMessagesToUIMessages", () => {
  it("maps a user text message", () => {
    const input: ModelMessage[] = [{ role: "user", content: "hello" }];
    const out = modelMessagesToUIMessages(input, { generateId });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(out[0].parts).toContainEqual({ type: "text", text: "hello" });
  });

  it("maps assistant text", () => {
    const input: ModelMessage[] = [{ role: "assistant", content: "hi there" }];
    const out = modelMessagesToUIMessages(input, { generateId });
    expect(out[0].role).toBe("assistant");
    expect(out[0].parts).toContainEqual({ type: "text", text: "hi there" });
  });

  it("maps a tool call and its result into one assistant turn", () => {
    const input: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "bash",
            output: { type: "text", value: "file.txt" },
          },
        ],
      },
    ];
    const out = modelMessagesToUIMessages(input, { generateId });
    const parts = out.flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "tool-bash", toolCallId: "call_1" })
    );
    // The result side carries the same tool name and an output state.
    const resultPart = parts.find(
      (p) => (p as { type: string }).type === "tool-bash" && "output" in p
    );
    expect(resultPart).toMatchObject({
      type: "tool-bash",
      toolCallId: "call_1",
      state: "output-available",
    });
  });

  it("preserves an approval signature part", () => {
    // If this part is dropped, convertToModelMessages() on the next turn
    // silently loses the signature and the approval gate fails open.
    const input = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-approval-request",
            approvalId: "appr_1",
            toolCallId: "call_1",
            signature: "hmac_signature_value",
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const out = modelMessagesToUIMessages(input, { generateId });
    const parts = out.flatMap((m) => m.parts);
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "tool-approval-request",
        approvalId: "appr_1",
        signature: "hmac_signature_value",
      })
    );
  });

  it("assigns a unique id to every message", () => {
    const input: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    const out = modelMessagesToUIMessages(input, { generateId });
    expect(new Set(out.map((m) => m.id)).size).toBe(out.length);
  });
});
