import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setMessageFeedback } from "../chat-storage";

describe("setMessageFeedback", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes the correct feedback endpoint with positive", async () => {
    await setMessageFeedback("chat-1", "msg-1", "positive");
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      "/api/chats/chat-1/messages/msg-1/feedback",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "positive" }),
      })
    );
  });

  it("PATCHes the correct endpoint with negative", async () => {
    await setMessageFeedback("chat-1", "msg-1", "negative");
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      "/api/chats/chat-1/messages/msg-1/feedback",
      expect.objectContaining({
        body: JSON.stringify({ feedback: "negative" }),
      })
    );
  });

  it("sends null to clear feedback", async () => {
    await setMessageFeedback("chat-1", "msg-1", null);
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      "/api/chats/chat-1/messages/msg-1/feedback",
      expect.objectContaining({
        body: JSON.stringify({ feedback: null }),
      })
    );
  });

  it("URL-encodes chatId and messageId", async () => {
    await setMessageFeedback("chat/a b", "msg/x y", "positive");
    expect(vi.mocked(global.fetch)).toHaveBeenCalledWith(
      "/api/chats/chat%2Fa%20b/messages/msg%2Fx%20y/feedback",
      expect.anything()
    );
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );
    await expect(
      setMessageFeedback("chat-1", "msg-1", "positive")
    ).rejects.toThrow("Failed to save feedback (HTTP 500)");
  });
});
