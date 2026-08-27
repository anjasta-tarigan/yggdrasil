import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import {
  defaultModel,
  defaultModelId,
  llm,
  type ProviderOverrides,
} from "@/lib/ai/provider";
import { listModels } from "@/lib/ai/models";
import { chatTools } from "@/lib/ai/tools";
import { formatErrorDetail } from "@/lib/ai/errors";
import { synthesizeSystemPrompt } from "@/lib/ai/prompt";
import { collectMcpTools, type McpToolCollection } from "@/lib/ai/mcp/manager";
import { chatActiveTracker } from "@/lib/queue/tracker";
import { enqueueJob } from "@/lib/queue/queue";
import { shouldReflectOnTurn } from "@/lib/memory/reflection";
import { bootstrapAutonomousCognitiveSystem } from "@/lib/bootstrap";

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

  const tools = mcp
    ? {
        ...chatTools,
        // Prefixed MCP tool names cannot collide with the built-ins, but
        // never let a remote server shadow them if one ever does.
        ...Object.fromEntries(
          Object.entries(mcp.tools).filter(([name]) => !(name in chatTools))
        ),
      }
    : chatTools;

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

  try {
    const result = streamText({
      model: model
        ? llm.chatModel(model, providerOverrides)
        : providerOverrides
          ? llm.chatModel(defaultModelId, providerOverrides)
          : defaultModel,
      system: fullSystemPrompt,
      messages: await convertToModelMessages(messages),
      tools,
      // Let the model run up to 5 steps (e.g. search, then fetch a result,
      // then answer) before it must produce a final response.
      stopWhen: stepCountIs(5),
      onEnd: async ({ text }) => {
        safeEndChatTracking();
        await mcp?.close();
        try {
          if (lastUserMessage && shouldReflectOnTurn(lastUserMessage, userMessagesCount)) {
            await enqueueJob({
              type: "reflect_turn",
              payload: {
                sessionId: chatId,
                userPrompt: lastUserMessage,
                assistantResponse: text,
              },
            });
          }
        } catch (err) {
          console.warn("[chat/route] Failed to enqueue reflection job:", err);
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

/**
 * Shape-guard client provider settings. Only http(s) base URLs and
 * bounded strings are accepted; anything malformed is ignored so the
 * server environment stays authoritative.
 */
function sanitizeProviderOverrides(
  value: unknown
): ProviderOverrides | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const baseUrl =
    typeof v.baseUrl === "string" &&
    v.baseUrl.length <= 2048 &&
    /^https?:\/\//.test(v.baseUrl)
      ? v.baseUrl.trim()
      : undefined;

  // Ollama: endpoint only, no API key.
  if (v.kind === "ollama") {
    return baseUrl ? { baseUrl, kind: "ollama" } : undefined;
  }

  const apiKey =
    typeof v.apiKey === "string" && v.apiKey.length <= 2048
      ? v.apiKey.trim() || undefined
      : undefined;
  if (!baseUrl && !apiKey) return undefined;
  return { apiKey, baseUrl };
}
