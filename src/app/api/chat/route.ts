import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  smoothStream,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import {
  defaultModel,
  defaultModelId,
  llm,
  sanitizeProviderOverrides,
  type ProviderOverrides,
} from "@/lib/ai/provider";
import { listModels } from "@/lib/ai/models";
import { chatTools } from "@/lib/ai/tools";
import { formatErrorDetail } from "@/lib/ai/errors";
import { synthesizeSystemPrompt } from "@/lib/ai/prompt";
import { collectMcpTools, type McpToolCollection } from "@/lib/ai/mcp/manager";
import { chatActiveTracker } from "@/lib/queue/tracker";
import { enqueueJob } from "@/lib/queue/queue";
import { bootstrapAutonomousCognitiveSystem } from "@/lib/bootstrap";
import { pruneMessagesToTokenBudget } from "@/lib/ai/context-budget";
import { createSandboxTools } from "@/lib/sandbox/host-sandbox";
import {
  getReasoningProviderOptions,
  createThinkTagStreamTransformer,
} from "@/lib/ai/reasoning";
import { syslog } from "@/lib/observability/log-store";

export async function POST(req: Request) {
  // Ensure background queue and cognitive loop handlers are bootstrapped
  bootstrapAutonomousCognitiveSystem();

  let body: {
    messages?: UIMessage[];
    model?: string;
    chatId?: string;
    provider?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON in request body.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const model = typeof body?.model === "string" ? body.model : undefined;
  const chatId = typeof body?.chatId === "string" ? body.chatId : undefined;
  const provider = body?.provider;

  // Context-window guard: keep the newest messages that fit the token
  // budget so long chats degrade gracefully instead of overflowing.
  const { messages: budgetedMessages, droppedCount } =
    pruneMessagesToTokenBudget(messages);
  if (droppedCount > 0) {
    console.info(
      `[chat/route] Context guard truncated ${droppedCount} older messages to fit the token budget.`
    );
  }

  // Optional per-request provider overrides from the Settings page.
  const providerOverrides = sanitizeProviderOverrides(provider);

  // Validate the requested model against the served list so a bad selection
  // fails fast with a clear message instead of an opaque upstream 404.
  // Skipped when the request targets an overridden endpoint — the local
  // model list does not apply there.
  if (model && model !== defaultModelId && !providerOverrides?.baseUrl) {
    const available = await listModels();
    if (
      available.length > 0 &&
      !available.some((m) => m.id === model)
    ) {
      // Plain text: the client transport surfaces the response body verbatim
      // as the error message.
      return new Response(`Model "${model}" is not available on this server.`, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  const lastUserMessage = messages
    .filter((m) => m.role === "user")
    .at(-1)
    ?.parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");

  const systemPrompt = await synthesizeSystemPrompt({
    userQuery: lastUserMessage,
  });

  // Connect the enabled MCP servers and collect their tools (drift-filtered,
  // slug-prefixed). Individual server failures are recorded but never block
  // the chat; when nothing is configured this is a cheap no-op.
  let mcp: McpToolCollection | undefined;
  try {
    mcp = await collectMcpTools();
  } catch (err) {
    console.warn("[chat/route] MCP tool collection failed:", err);
  }

  // Sandbox workspace tools (bash, readFile, writeFile) confined to
  // data/sandbox. Construction is synchronous and cannot fail.
  const baseTools = { ...chatTools, ...createSandboxTools() };

  const tools = mcp
    ? {
        ...baseTools,
        // Prefixed MCP tool names cannot collide with the built-ins, but
        // never let a remote server shadow them if one ever does.
        ...Object.fromEntries(
          Object.entries(mcp.tools).filter(([name]) => !(name in baseTools))
        ),
      }
    : baseTools;

  const fullSystemPrompt = mcp?.instructions
    ? `${systemPrompt}\n\n${mcp.instructions}`
    : systemPrompt;

  // Track active chat for background queue GPU protection
  chatActiveTracker.startChat();
  let hasEndedChatTracking = false;
  const safeEndChatTracking = () => {
    if (!hasEndedChatTracking) {
      hasEndedChatTracking = true;
      chatActiveTracker.endChat();
    }
  };

  const userMessagesCount = messages.filter((m) => m.role === "user").length;
  let accumulatedText = "";

  try {
    const result = streamText({
      model: model
        ? llm.chatModel(model, providerOverrides)
        : providerOverrides
          ? llm.chatModel(defaultModelId, providerOverrides)
          : defaultModel,
      system: fullSystemPrompt,
      messages: await convertToModelMessages(budgetedMessages),
      tools,
      providerOptions: getReasoningProviderOptions(model || defaultModelId, "xhigh"),
      abortSignal: req.signal,
      // Let the model run up to 15 steps so multi-tool work (search → fetch
      // → remember → artifact) does not hit the cap mid-task. The active
      // chat mutex keeps background jobs off the GPU meanwhile.
      stopWhen: stepCountIs(15),
      experimental_transform: smoothStream({ chunking: "word", delayInMs: 10 }),
      onStepFinish: ({ text, toolCalls, toolResults, usage }) => {
        if (text) {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
        }
        if (toolCalls && toolCalls.length > 0) {
          const names = toolCalls.map((t) => t.toolName).join(", ");
          syslog(
            "info",
            "agent",
            `Chat step executed tools [${names}], tokens: ${usage?.totalTokens ?? 0}`
          );
        }
      },
      onEnd: async ({ text }) => {
        safeEndChatTracking();
        await mcp?.close();
        try {
          const finalText = (text && text.trim().length > 0 ? text : accumulatedText).trim();
          // Persist the finished turn into episodic memory via the durable
          // queue. The ingestion handler also decides whether the turn is
          // worth a deeper LLM reflection (corrections, preferences,
          // milestones) and enqueues `reflect_turn` when it is.
          if (lastUserMessage && finalText.length > 0) {
            await enqueueJob({
              type: "ingest_turn",
              payload: {
                sessionId: chatId,
                userPrompt: lastUserMessage,
                assistantResponse: finalText,
                userMessagesCount,
              },
            });
          }
        } catch (err) {
          console.warn("[chat/route] Failed to enqueue turn ingestion job:", err);
        }
      },
      onError: () => {
        safeEndChatTracking();
        void mcp?.close();
      },
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        // Attach per-step token usage to the assistant message metadata so
        // the client's context-window indicator shows real numbers.
        messageMetadata: ({ part }) => {
          if (part.type === "finish-step") {
            return { usage: part.usage };
          }
          return undefined;
        },
        onError: (error) => {
          safeEndChatTracking();
          console.error("[chat] stream error:", error);
          const detail = formatErrorDetail(error);
          return model
            ? `Request to model "${model}" failed: ${detail}`
            : `Request failed: ${detail}`;
        },
      }),
    });
  } catch (err) {
    safeEndChatTracking();
    void mcp?.close();
    throw err;
  }
}
