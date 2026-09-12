import { describe, it, expect, expectTypeOf } from "vitest";
import type { UIMessage } from "ai";
import type { ChatUIMessage } from "@/app/api/chat/route";

/**
 * Type-level tests for the ChatUIMessage export.
 *
 * ChatUIMessage is produced by InferAgentUIMessage<ChatAgentT> so that
 * client components using useChat<ChatUIMessage>() get fully type-checked
 * tool-call / tool-result part types.
 *
 * Primary verification is `npx tsc --noEmit` (the type relationships).
 * The runtime assertions below also let vitest run the file as a valid
 * test module.
 */
describe("ChatUIMessage", () => {
  it("is importable from the chat route", () => {
    // A minimal UIMessage-shaped value satisfies the type — this guards
    // the export against accidental renames or removals at import site.
    const sample: ChatUIMessage = {
      id: "test",
      role: "user",
      parts: [],
    };
    expect(sample.id).toBe("test");
  });

  it("is a UIMessage subtype", () => {
    expectTypeOf<ChatUIMessage>().toMatchTypeOf<UIMessage>();
  });

  it("has an id property", () => {
    expectTypeOf<ChatUIMessage>().toHaveProperty("id");
  });

  it("has a role property", () => {
    expectTypeOf<ChatUIMessage>().toHaveProperty("role");
  });

  it("has a parts array", () => {
    expectTypeOf<ChatUIMessage>().toHaveProperty("parts");
  });

  it("is assignable back to a generic UIMessage", () => {
    // ChatUIMessage (narrow, tool-specific parts) is assignable to the
    // generic UIMessage (wide, union tool parts). This is the direction
    // that matters for passing messages from the server route to generic
    // rendering components.
    const typed: ChatUIMessage = { id: "x", role: "user", parts: [] };
    const base: UIMessage = typed;
    expect(base).toBe(typed);
  });
});
