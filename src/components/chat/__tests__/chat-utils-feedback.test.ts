import { describe, it, expect } from "vitest";
import type { UIMessage } from "ai";
import { getFeedback, hasFeedback } from "../chat-utils";

type PartialMsg = { id: string; role: "assistant"; parts: { type: "text"; text: string }[]; metadata?: Record<string, unknown> };

function makeMsg(feedback?: "positive" | "negative" | null): PartialMsg {
  return {
    id: "m1",
    role: "assistant",
    parts: [{ type: "text", text: "Hello" }],
    ...(feedback !== undefined ? { metadata: { feedback } } : {}),
  };
}

describe("getFeedback", () => {
  it("returns the feedback value when positive", () => {
    expect(getFeedback(makeMsg("positive") as UIMessage)).toBe("positive");
  });

  it("returns the feedback value when negative", () => {
    expect(getFeedback(makeMsg("negative") as UIMessage)).toBe("negative");
  });

  it("returns undefined when no feedback is set", () => {
    expect(getFeedback(makeMsg(undefined) as UIMessage)).toBeUndefined();
  });

  it("returns undefined when metadata has no feedback key", () => {
    const msg = { id: "m2", role: "assistant" as const, parts: [], metadata: { usage: {} } } as UIMessage;
    expect(getFeedback(msg)).toBeUndefined();
  });

  it("returns undefined when feedback is null", () => {
    expect(getFeedback(makeMsg(null) as UIMessage)).toBeUndefined();
  });
});

describe("hasFeedback", () => {
  it("returns true when feedback is positive", () => {
    expect(hasFeedback(makeMsg("positive") as UIMessage)).toBe(true);
  });

  it("returns true when feedback is negative", () => {
    expect(hasFeedback(makeMsg("negative") as UIMessage)).toBe(true);
  });

  it("returns false when feedback is null", () => {
    expect(hasFeedback(makeMsg(null) as UIMessage)).toBe(false);
  });

  it("returns false when feedback is absent", () => {
    expect(hasFeedback(makeMsg(undefined) as UIMessage)).toBe(false);
  });
});
