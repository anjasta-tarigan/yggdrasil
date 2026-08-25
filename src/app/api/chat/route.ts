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
import { chatActiveTracker } from "@/lib/queue/tracker";
import { enqueueJob } from "@/lib/queue/queue";
import { shouldReflectOnTurn } from "@/lib/memory/reflection";
import { bootstrapAutonomousCognitiveSystem } from "@/lib/bootstrap";

export async function POST(req: Request) {
  // Ensure background queue and cognitive loop handlers are bootstrapped
  bootstrapAutonomousCognitiveSystem();

  const {
    messages,
    model,
    chatId,
    provider,
  }: {
    messages: UIMessage[];
    model?: string;
    chatId?: string;
    provider?: unknown;
  } = await req.json();

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

  // Track active chat for background queue GPU protection
  chatActiveTracker.startChat();

  const userMessagesCount = messages.filter((m) => m.role === "user").length;

  const result = streamText({
    model: model
      ? llm.chatModel(model, providerOverrides)
      : providerOverrides
        ? llm.chatModel(defaultModelId, providerOverrides)
        : defaultModel,
    system: systemPrompt,
    messages: await convertToModelMessages(messages),
    tools: chatTools,
    // Let the model run up to 5 steps (e.g. search, then fetch a result,
    // then answer) before it must produce a final response.
    stopWhen: stepCountIs(5),
    onFinish: async ({ text }) => {
      chatActiveTracker.endChat();
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
      chatActiveTracker.endChat();
    },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      // Attach per-step token usage to the assistant message metadata so
      // the client's context-window indicator shows real numbers. The last
      // step's usage wins: its inputTokens is the full prompt of the final
      // request (whole conversation + tool results), i.e. the true context
      // size — unlike totalUsage, which sums every step and double-counts
      // the growing prompt in multi-step tool loops.
      messageMetadata: ({ part }) => {
        if (part.type === "finish-step") {
          return { usage: part.usage };
        }
        return undefined;
      },
      // Surface a readable error (including the failing model) instead of
      // the default generic "An error occurred." message.
      onError: (error) => {
        chatActiveTracker.endChat();
        console.error("[chat] stream error:", error);
        const detail = formatErrorDetail(error);
        return model
          ? `Request to model "${model}" failed: ${detail}`
          : `Request failed: ${detail}`;
      },
    }),
  });
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
