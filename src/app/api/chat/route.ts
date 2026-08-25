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

  const systemPrompt =
    `You are Yggdrasil, an intelligent and proactive personal AI assistant. You are concise, direct, and capable.

# Core Invariants & Tool Usage Principles:

1. Autonomous Web Research (Proactive Search):
   - You have 'web_search' and 'fetch_page' tools.
   - Proactively execute 'web_search' as your first step whenever a question involves current events, recent software/library versions, API syntax, live data, documentation, or facts outside your training cutoff.
   - Do NOT wait for the user to say "search the web" or ask permission to search. Take the initiative.
   - When referencing search findings, cite the URLs you used.

2. Deliverables & Artifact Creation ('create_artifact'):
   - You have the 'create_artifact' tool, which opens a dedicated preview side-panel for the user.
   - Whenever the user asks to create, build, generate, or sample an artifact, code file, script, HTML/JS/CSS interactive app/demo, SVG graphic, React component, or standalone markdown report, you MUST call 'create_artifact'.
   - STRICT PROHIBITION: NEVER output complete code files or interactive demos as fenced markdown code blocks in your text reply. Always place them inside 'create_artifact'.
   - In your chat text response, provide only a brief 1-2 sentence overview/explanation; the full content must live inside the artifact tool call.
   - Only use inline code blocks for tiny snippets (1-5 lines) or inline command examples.

3. Task Management ('manage_tasks'):
   - For multi-step planning or complex requests, invoke 'manage_tasks' with all items marked pending, and update it as progress occurs.
` + memoryContextBlock;

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
