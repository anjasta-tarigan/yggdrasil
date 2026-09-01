import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  InvalidToolInputError,
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
import { buildSubagentToolsForChat } from "@/lib/ai/subagent-runner";
import { formatErrorDetail } from "@/lib/ai/errors";
import { synthesizeSystemPrompt } from "@/lib/ai/prompt";
import { collectMcpTools, type McpToolCollection } from "@/lib/ai/mcp/manager";
import { filterToolsForChat } from "@/lib/ai/tool-toggles";
import { chatActiveTracker } from "@/lib/queue/tracker";
import { enqueueJob } from "@/lib/queue/queue";
import { bootstrapAutonomousCognitiveSystem } from "@/lib/bootstrap";
import { pruneMessagesToTokenBudget } from "@/lib/ai/context-budget";
import { processIncomingMessageAttachments } from "@/lib/ai/attachments";
import { secureFetch } from "@/lib/security/ssrf";
import { createSandboxTools } from "@/lib/sandbox/host-sandbox";
import {
  getReasoningProviderOptions,
  createThinkTagStreamTransformer,
} from "@/lib/ai/reasoning";
import { evaluateToolApproval } from "@/lib/ai/tool-policy";
import { repairToolCallInput } from "@/lib/ai/tool-repair";
import { publishStream } from "@/lib/ai/stream-registry";
import {
  clearActiveStreamIdDb,
  getActiveStreamIdDb,
  getChatDb,
  saveChatDb,
  setActiveStreamIdDb,
} from "@/lib/chat-service";
import { deriveTitle } from "@/lib/chat-storage";
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

  // Process any file attachments (decode text/code files into markdown blocks)
  const processedMessages = await processIncomingMessageAttachments(messages);

  // Context-window guard: keep the newest messages that fit the token
  // budget so long chats degrade gracefully instead of overflowing.
  const { messages: budgetedMessages, droppedCount } =
    pruneMessagesToTokenBudget(processedMessages);
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

  // Resumable-stream prerequisite: the chat row must exist BEFORE the
  // generation starts, or the active-stream pointer has nothing to
  // attach to and resume silently breaks for a first-message run (the
  // row previously appeared only when the client saved the finished
  // turn). Official guide pattern: save the (new) chat up front, then
  // stream.
  if (chatId) {
    try {
      const existing = await getChatDb(chatId);
      if (!existing) {
        await saveChatDb({
          id: chatId,
          title: deriveTitle(messages),
          updatedAt: Date.now(),
          messages,
        });
      }
    } catch (err) {
      // Never block the turn on persistence: chat creation retries on
      // the server-side settle save at stream end.
      console.warn("[chat/route] Pre-stream chat row creation failed:", err);
    }
  }

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

  // Subagent delegation tools — one per enabled user-managed subagent.
  // Built fresh each request so edits/toggles apply on the next turn.
  // Failures never block chat: subagent toolsets degrade to none.
  let subagentToolEntries: Array<Record<string, unknown>> = [];
  try {
    subagentToolEntries = buildSubagentToolsForChat(providerOverrides).map(
      ({ name, tool }) => ({ [name]: tool })
    );
  } catch (err) {
    console.warn("[chat/route] Subagent tool build failed:", err);
  }
  const subagentTools = Object.assign({}, ...subagentToolEntries) as Record<
    string,
    unknown
  >;

  // Final merged toolset, then the per-tool toggle policy has the last
  // word: any tool the user disabled in Settings → Tools is removed from
  // the model-visible set for this request.
  const tools = filterToolsForChat(
    mcp
      ? {
          ...baseTools,
          ...subagentTools,
          // Defense-in-depth: collectMcpTools already withholds MCP tools
          // whose underlying name duplicates a built-in, but if a
          // slug-prefixed name still collides with a local key, the local
          // tool wins.
          ...Object.fromEntries(
            Object.entries(mcp.tools).filter(
              ([name]) =>
                !(name in baseTools) && !(name in subagentTools)
            )
          ),
        }
      : { ...baseTools, ...subagentTools }
  );

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
      // Pass the live toolset so tool outputs (notably a delegate tool's
      // accumulated UIMessage) replay through toModelOutput as compressed
      // text on every later turn instead of JSON-serializing whole into
      // the model context (context overflow on long chats).
      //
      // ignoreIncompleteToolCalls: a tool call interrupted mid-flight (user
      // hits Stop, the browser refreshes, or a slow MCP server — parallel
      // search can take 30–90s — gets aborted) leaves its UI part in a
      // non-terminal state in the persisted history. Without this flag the
      // SDK throws MissingToolResultsError for that dangling call on every
      // later request in the chat; with it, unfinished calls are filtered
      // out of the model-visible history so the conversation continues.
      messages: await convertToModelMessages(budgetedMessages, {
        ignoreIncompleteToolCalls: true,
        tools,
      }),
      tools,
      providerOptions: getReasoningProviderOptions(model || defaultModelId, "xhigh"),
      // Resumable streams: DO NOT pass abortSignal: req.signal here.
      // The official docs call this out as the classic resume bug — a
      // client disconnect (page refresh, chat switch, tab close) would
      // abort the model generation, killing the very stream the
      // registry is supposed to keep alive for re-attachment. The
      // stop endpoint is the only legitimate cancellation path.
      experimental_download: async (requestedDownloads) => {
        return Promise.all(
          requestedDownloads.map(async ({ url, isUrlSupportedByModel }) => {
            if (isUrlSupportedByModel) return null;
            const res = await secureFetch(url.toString(), {
              signal: req.signal,
            });
            const buffer = await res.arrayBuffer();
            return {
              data: new Uint8Array(buffer),
              mediaType: res.headers.get("content-type") ?? undefined,
            };
          })
        );
      },
      // Policy-based tool approvals (spec: tool-approvals-qna-design §3):
      // destructive bash commands, skill mutations and destructive-verb MCP
      // tools pause the loop in "approval-requested" until the user accepts
      // or denies via the Confirmation card (addToolApprovalResponse).
      // MCP tools are NOT blanket-gated: the spec scopes approvals to
      // destructive verbs (delete/drop/destroy), which evaluateToolApproval
      // already detects in slugged MCP names. Blanket-gating every dynamic
      // tool froze safe calls like parallel-search__web_search in
      // approval-requested forever.
      toolApproval: async ({ toolCall }) => {
        return evaluateToolApproval(toolCall.toolName, toolCall.input);
      },
      // Deterministic repair for common tool-input shape mistakes (e.g.
      // a model sending "search_queries": "gold price" where the schema
      // wants an array). Without this the call is marked invalid, never
      // executes, and the user sees "Could not execute tool(s): …".
      // Repair is schema-driven coercion, not an LLM round-trip; null
      // falls through to the SDK's default invalid-call handling.
      repairToolCall: async ({ toolCall, inputSchema, error }) => {
        if (!InvalidToolInputError.isInstance(error)) return null;
        try {
          const schema = await inputSchema({ toolName: toolCall.toolName });
          const repaired = repairToolCallInput(toolCall, schema);
          if (repaired) {
            syslog(
              "info",
              "agent",
              `Repaired tool input for ${toolCall.toolName} (schema coercion)`
            );
            return { ...toolCall, input: repaired.input };
          }
        } catch {
          return null;
        }
        return null;
      },
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

    // The assistant stream's final messages, as assembled by the SDK from
    // the original request + streamed parts. Persisted server-side below
    // so the turn survives a page close mid-generation (the client's
    // onSettled save never fires on a dead page).
    let settledMessages: UIMessage[] | null = null;

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        // Persistence mode: provide the originals so the SDK assigns a
        // stable message id to the response and hands back the full
        // updated list in onEnd.
        originalMessages: messages,
        generateMessageId: generateId,
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
        // Server-authoritative save (resumable-stream contract): the
        // client's settle-save remains for the live client, but a client
        // that died mid-stream (refresh, tab close, navigation) leaves
        // the finished turn in the database anyway.
        onEnd: async ({ messages: finalMessages }) => {
          settledMessages = finalMessages;
          if (chatId && finalMessages.length > 0) {
            try {
              await saveChatDb({
                id: chatId,
                title: deriveTitle(finalMessages),
                updatedAt: Date.now(),
                messages: finalMessages,
              });
            } catch (err) {
              console.warn("[chat/route] Server-side settle save failed:", err);
            }
            // Clear the resume pointer so a later GET does not answer
            // with a dead stream (the registry entry self-removed).
            await clearActiveStreamIdDb(chatId).catch(() => {});
          }
        },
      }),
      // Publish a resumable copy of the SSE stream: the registry holds
      // its branch open, so the generation survives the HTTP response
      // closing (page refresh, chat switch, tab hide) and a reconnect
      // via GET /api/chat/[chatId]/stream re-attaches to it.
      consumeSseStream: ({ stream }) => {
        if (!chatId) return;
        const streamId = generateId();
        publishStream(streamId, chatId, stream);
        void setActiveStreamIdDb(chatId, streamId).then((ok) => {
          if (!ok) {
            // Chat deleted mid-run: nothing to point at, but the model
            // still runs so a live client watching keeps its stream.
            syslog("info", "agent", `Chat ${chatId} vanished before stream registration`);
          }
        });
      },
    });
  } catch (err) {
    safeEndChatTracking();
    void mcp?.close();
    throw err;
  }
}
