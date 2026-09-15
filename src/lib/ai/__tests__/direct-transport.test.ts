import { describe, it, expect, vi } from "vitest";
import { DirectChatTransport, type ToolLoopAgent, type UIMessage } from "ai";
import { createDirectChatTransport } from "../direct-transport";

/**
 * A permissive call-options shape for the mock `ToolLoopAgent`. It carries the
 * two hooks the factory forwards (prepareStep / prepareSendMessages) plus an
 * index signature so arbitrary call-time settings can be supplied and asserted
 * against in tests without a real LanguageModel.
 */
type TestAgentOptions = {
  prepareStep?: (options: Record<string, unknown>) => unknown | Promise<unknown>;
  prepareSendMessages?: (opts: {
    messages: UIMessage[];
  }) => UIMessage[] | Promise<UIMessage[]>;
  [key: string]: unknown;
};

type TestAgent = ToolLoopAgent<TestAgentOptions>;

/** A ReadableStream that is already closed — no chunk processing, no network. */
function closedStream(): ReadableStream {
  return new ReadableStream({ start(controller) { controller.close(); } });
}

/** Build an in-process agent stand-in with a spied `stream` (no model, no HTTP). */
function makeAgent(
  streamImpl?: ReturnType<typeof vi.fn>,
): TestAgent {
  const stream =
    streamImpl ?? vi.fn().mockResolvedValue({ stream: closedStream() });
  return { stream, tools: {} } as unknown as TestAgent;
}

/**
 * Minimal sendMessages args matching `ChatTransport.sendMessages`. The messages
 * are typed against the transport's default UI_MESSAGE
 * (`UIMessage<unknown, never, {}>`) so they assign cleanly.
 * `validateUIMessages` rejects an empty messages array, so a real user message
 * is required to drive `DirectChatTransport.sendMessages`.
 */
function sendArgs() {
  const messages: UIMessage<unknown, never, Record<string, never>>[] = [
    { id: "msg-1", role: "user", parts: [{ type: "text", text: "hello" }] },
  ];
  return {
    trigger: "submit-message" as const,
    chatId: "test-chat",
    messageId: undefined as string | undefined,
    messages,
    abortSignal: undefined as AbortSignal | undefined,
  };
}

describe("createDirectChatTransport", () => {
  it("returns an instance of DirectChatTransport", () => {
    const transport = createDirectChatTransport(makeAgent());
    expect(transport).toBeInstanceOf(DirectChatTransport);
  });

  it("can be instantiated with a minimal ToolLoopAgent (mock)", () => {
    const stream = vi.fn().mockResolvedValue({ stream: closedStream() });
    const agent = makeAgent(stream);

    const transport = createDirectChatTransport(agent);

    expect(transport).toBeInstanceOf(DirectChatTransport);
    // Construction must be lazy — the agent is not streamed until asked.
    expect(stream).not.toHaveBeenCalled();
  });

  it("throws a TypeError when agent is null", () => {
    expect(() =>
      createDirectChatTransport(null as unknown as TestAgent),
    ).toThrow(/agent/);
  });

  it("throws a TypeError when agent is undefined", () => {
    expect(() =>
      createDirectChatTransport(undefined as unknown as TestAgent),
    ).toThrow(/agent/);
  });

  it("passes prepareStep through to the agent's stream() options", async () => {
    const stream = vi.fn().mockResolvedValue({ stream: closedStream() });
    const agent = makeAgent(stream);
    const prepareStep = vi.fn();

    const transport = createDirectChatTransport(agent, { prepareStep });
    await transport.sendMessages(sendArgs());

    expect(stream).toHaveBeenCalledTimes(1);
    const call = stream.mock.calls[0][0] as {
      options?: { prepareStep?: unknown };
    };
    expect(call.options?.prepareStep).toBe(prepareStep);
  });

  it("passes prepareSendMessages through to the agent's stream() options", async () => {
    const stream = vi.fn().mockResolvedValue({ stream: closedStream() });
    const agent = makeAgent(stream);
    const prepareSendMessages = vi.fn();

    const transport = createDirectChatTransport(agent, { prepareSendMessages });
    await transport.sendMessages(sendArgs());

    expect(stream).toHaveBeenCalledTimes(1);
    const call = stream.mock.calls[0][0] as {
      options?: { prepareSendMessages?: unknown };
    };
    expect(call.options?.prepareSendMessages).toBe(prepareSendMessages);
  });

  it("passes both prepareStep and prepareSendMessages through together", async () => {
    const stream = vi.fn().mockResolvedValue({ stream: closedStream() });
    const agent = makeAgent(stream);
    const prepareStep = vi.fn();
    const prepareSendMessages = vi.fn();

    const transport = createDirectChatTransport(agent, {
      prepareStep,
      prepareSendMessages,
    });
    await transport.sendMessages(sendArgs());

    const call = stream.mock.calls[0][0] as {
      options?: { prepareStep?: unknown; prepareSendMessages?: unknown };
    };
    expect(call.options?.prepareStep).toBe(prepareStep);
    expect(call.options?.prepareSendMessages).toBe(prepareSendMessages);
  });

  it("does not set agent options when none are provided", async () => {
    const stream = vi.fn().mockResolvedValue({ stream: closedStream() });
    const agent = makeAgent(stream);

    const transport = createDirectChatTransport(agent);
    await transport.sendMessages(sendArgs());

    const call = stream.mock.calls[0][0] as { options?: unknown };
    expect(call.options).toBeUndefined();
  });
});
