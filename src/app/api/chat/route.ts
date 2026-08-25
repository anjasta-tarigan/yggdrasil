import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { defaultModel, defaultModelId, llm } from "@/lib/ai/provider";
import { listModels } from "@/lib/ai/models";
import { chatTools } from "@/lib/ai/tools";
import { formatErrorDetail } from "@/lib/ai/errors";
import { getActiveWorkingMemories } from "@/lib/memory/working-memory";
import { hybridMemorySearch } from "@/lib/memory/search";

export async function POST(req: Request) {
  const {
    messages,
    model,
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

  // Retrieve working memory and relevant long-term memory
  let memoryContextBlock = "";
  try {
    const activeWorking = await getActiveWorkingMemories();
    const lastUserMessage = messages
      .filter((m) => m.role === "user")
      .at(-1)
      ?.parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");

    let relevantMemories: Awaited<ReturnType<typeof hybridMemorySearch>> = [];
    if (lastUserMessage) {
      relevantMemories = await hybridMemorySearch(lastUserMessage, { limit: 5 });
    }

    const workingSnippets = activeWorking.map((w) => `• [Working]: ${w.content}`).join("\n");
    const longTermSnippets = relevantMemories.map((r) => `• [${r.type}]: ${r.content}`).join("\n");

    if (workingSnippets || longTermSnippets) {
      memoryContextBlock = `\n\n<cognitive_memory_context>\n${[workingSnippets, longTermSnippets]
        .filter(Boolean)
        .join("\n")}\n</cognitive_memory_context>\n`;
    }
  } catch (err) {
    console.warn("[chat/route] Memory retrieval fallback:", err);
  }

  const result = streamText({
    model: model
      ? llm.chatModel(model, providerOverrides)
      : providerOverrides
        ? llm.chatModel(defaultModelId, providerOverrides)
        : defaultModel,
    system:
      "You are Yggdrasil, a helpful personal AI assistant. Be concise and direct. " +
      "You have web_search and fetch_page tools for current information; use them when a question needs up-to-date or external data, and cite the URLs you used. " +
      "For complex multi-step requests, use the manage_tasks tool to show the user a plan, and call it again as you progress to mark items in_progress or completed. " +
      "You also have the create_artifact tool: when you produce self-contained, reusable content the user would save as a distinct file (a complete code file, an HTML/CSS/JS demo, an SVG graphic, a React component, or a report/document), call it instead of outputting a fenced code block. Pass the full content there; do not also print it in prose — a one-line summary suffices. Each call is independently viewable in the side panel. Do not use it for brief snippets or explanations that belong inline.\n\n" +
      memoryContextBlock,
    messages: await convertToModelMessages(messages),
    tools: chatTools,
    // Let the model run up to 5 steps (e.g. search, then fetch a result,
    // then answer) before it must produce a final response.
    stopWhen: stepCountIs(5),
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
 * Shape-guard client provider overrides. Only http(s) base URLs and
 * bounded strings are accepted; anything malformed is ignored so the
 * server environment stays authoritative.
 */
function sanitizeProviderOverrides(
  value: unknown
): { apiKey?: string; baseUrl?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const baseUrl =
    typeof v.baseUrl === "string" &&
    v.baseUrl.length <= 2048 &&
    /^https?:\/\//.test(v.baseUrl)
      ? v.baseUrl.trim()
      : undefined;
  const apiKey =
    typeof v.apiKey === "string" && v.apiKey.length <= 2048
      ? v.apiKey.trim() || undefined
      : undefined;
  if (!baseUrl && !apiKey) return undefined;
  return { apiKey, baseUrl };
}
