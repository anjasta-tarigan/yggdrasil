import { DirectChatTransport } from "ai";
import type {
  PrepareStepFunction,
  ToolLoopAgent,
  UIMessage,
  UIMessageStreamOptions,
} from "ai";

type MaybePromise<T> = T | Promise<T>;

/**
 * Options accepted by `createDirectChatTransport`.
 *
 * Mirrors AI SDK v7's `DirectChatTransportOptions` (the `agent` is taken by
 * the factory's first argument) and forwards the agent's per-call hooks as
 * first-class fields so test code can wire them up without importing the SDK
 * transport or standing up the `/api/chat` route:
 *
 * - `prepareStep` — a native `ToolLoopAgent` per-step hook (mirrors
 *   `ToolLoopAgentSettings.prepareStep`); routed into the agent's per-call
 *   options so it is observed at stream time.
 * - `prepareSendMessages` — a per-call message-preparation hook invoked before
 *   each batch of messages is handed to the model.
 */
export interface DirectTransportOptions<CALL_OPTIONS>
  extends Omit<UIMessageStreamOptions<UIMessage<unknown, never, {}>>, "onFinish"> {
  /** Per-call agent options forwarded to `agent.stream()` (e.g. ToolLoopAgent settings). */
  options?: CALL_OPTIONS;
  /** Per-step hook forwarded into the agent's per-call options. */
  prepareStep?: PrepareStepFunction<{}>;
  /** Per-call message-preparation hook forwarded into the agent's per-call options. */
  prepareSendMessages?: (opts: {
    messages: UIMessage[];
  }) => MaybePromise<UIMessage[]>;
}

/**
 * Build an in-process `DirectChatTransport` for a chat agent.
 *
 * Wraps `new DirectChatTransport({ agent, ... })`, routing `prepareStep` /
 * `prepareSendMessages` (and any other agent call options) into the agent's
 * per-call options bag so they reach `agent.stream()`. Lets integration tests
 * drive a `ToolLoopAgent` directly — with no HTTP mock transport and no
 * `/api/chat` round-trip.
 *
 * @throws {TypeError} when `agent` is `null` or `undefined`.
 */
export function createDirectChatTransport<CALL_OPTIONS>(
  agent: ToolLoopAgent<CALL_OPTIONS>,
  options?: DirectTransportOptions<CALL_OPTIONS>,
): DirectChatTransport<CALL_OPTIONS> {
  if (agent == null) {
    throw new TypeError(
      "createDirectChatTransport: `agent` (a ToolLoopAgent) is required",
    );
  }

  const {
    prepareStep,
    prepareSendMessages,
    options: agentOptions,
    ...rest
  } = options ?? ({} as DirectTransportOptions<CALL_OPTIONS>);

  // Merge the per-call hooks into the agent's options bag. The spread of
  // `agentOptions` (a CALL_OPTIONS) plus the two adapter hooks is forwarded as
  // the agent's `options` at stream time.
  const mergedOptions = {
    ...agentOptions,
    ...(prepareStep !== undefined ? { prepareStep } : {}),
    ...(prepareSendMessages !== undefined ? { prepareSendMessages } : {}),
  } as unknown as CALL_OPTIONS;

  const hasOptions =
    prepareStep !== undefined ||
    prepareSendMessages !== undefined ||
    agentOptions !== undefined;

  return new DirectChatTransport<CALL_OPTIONS>({
    agent,
    options: hasOptions ? mergedOptions : undefined,
    ...rest,
  });
}
