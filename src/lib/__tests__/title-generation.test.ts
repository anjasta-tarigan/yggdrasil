import { describe, it, expect, vi, afterEach } from "vitest";
import { generateChatTitle, TITLE_MAX_LENGTH } from "../title-generation";
import type { UIMessage } from "ai";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateChatTitle", () => {
  it("returns fallback when there are no user messages", async () => {
    const messages: UIMessage[] = [
      {
        id: "1",
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
      },
    ];
    const result = await generateChatTitle(messages, {} as never, {
      fallback: "Default Title",
    });
    expect(result).toBe("Default Title");
  });

  it("returns fallback when user text is empty after filtering", async () => {
    const messages: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "   " }],
      },
    ];
    const result = await generateChatTitle(messages, {} as never, {
      fallback: "No Content",
    });
    expect(result).toBe("No Content");
  });

  it("trims and truncates the generated title to TITLE_MAX_LENGTH", async () => {
    const longTitle = "A".repeat(100);
    const messages: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "Explain quantum computing" }],
      },
    ];

    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({ text: longTitle }),
    }));

    const { generateChatTitle: gen } = await import("../title-generation");
    const result = await gen(messages, {} as never, { fallback: "fallback" });
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });
});
