import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  InvalidToolInputError,
  smoothStream,
  ToolLoopAgent,
  streamText,
  toUIMessageStream,
  type InferAgentUIMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  chatModelForEntry,
  getDefaultModelEntry,
} from "@/lib/ai/provider";
import {
  loadRegistry,
  resolveApiKey,
  ProviderConfigError,
} from "@/lib/ai/provider-config/store";
import type { ModelEntry } from "@/lib/ai/provider-config/schema";
import { getWebSession } from "@/lib/ai/web-provider/session-store";
import type { WebProviderSession } from "@/lib/ai/web-provider/types";
import { ERROR_MAPPING } from "@/lib/ai/web-provider/adapter";
import { env, refreshEnv } from "@/env";
import { decodeModelRef } from "@/lib/settings";
import { chatTools } from "@/lib/ai/tools";
import { createGetDeviceLocationTool } from "@/lib/ai/tools/location";
import { buildSubagentToolsForChat } from "@/lib/ai/subagent-runner";
import { formatErrorDetail } from "@/lib/ai/errors";
import { synthesizeSystemPrompt, extractLearnedRulesAndPreferences } from "@/lib/ai/prompt";
import { collectMcpTools } from "@/lib/ai/mcp/manager";
import { buildCustomToolsForChat } from "@/lib/ai/custom-tools/builder";
import { filterToolsForChat } from "@/lib/ai/tool-toggles";
import { createChatStopConditions } from "@/lib/ai/termination-conditions";
import { buildRuntimeContext } from "@/lib/ai/runtime-context";
import { createPrepareStep } from "@/lib/ai/prepare-step";
import { chatActiveTracker } from "@/lib/queue/tracker";
import { enqueueJob } from "@/lib/queue/queue";
import { bootstrapAutonomousCognitiveSystem } from "@/lib/bootstrap";
import {
  estimateTokens,
  calculateContextTokenBudget,
  compactAndPruneMessages,
  estimateMessageTokens,
  getTokenRatio,
  recordTokenRatio,
} from "@/lib/ai/context-budget";
import { processIncomingMessageAttachments } from "@/lib/ai/attachments";
import { secureFetch } from "@/lib/security/ssrf";
import { createSandboxTools } from "@/lib/sandbox/host-sandbox";
import {
  calculateReasoningOutputBudget,
  classifyTaskReasoningEffort,
  reconcileThinkingBudget,
  type ReasoningEffortTier,
} from "@/lib/ai/reasoning";
import { evaluateToolApproval } from "@/lib/ai/tool-policy";
import { resolveApprovalSecret } from "@/lib/ai/approval-secret";
import { repairToolCallInput } from "@/lib/ai/tool-repair";
import { publishStream } from "@/lib/ai/stream-registry";
import { inferKnownModelCapabilities } from "@/lib/ai/model-heuristics";
import {
  clearActiveStreamIdDb,
  getChatDb,
  saveChatDb,
  setActiveStreamIdDb,
} from "@/lib/chat-service";
import { deriveTitle } from "@/lib/chat-storage";
import { generateChatTitle } from "@/lib/title-generation";
import { syslog, recordAgentMetric } from "@/lib/observability/log-store";
import { detectAndMarkTopicShift } from "@/lib/memory/topic-handoff";
import { getRollingSummary, updateRollingSummary } from "@/lib/memory/rolling-summary";
import {
  setChatDeviceLocation,
  getChatDeviceLocation,
  type ResolvedLocation,
} from "@/lib/location/geocoding";

// Module-level ToolLoopAgent type for end-to-end type safety.
// We don't construct an instance — just use the type parameters
// to infer the UIMessage parts (tool calls, results) from the tool set.
// `typeof chatTools` captures the full union of builtin + skill tools
// so useChat<T> on the client gets type-checked tool parts.
//
// The spread type of chatTools (skill + builtin tools) doesn't
// structurally satisfy ToolSet's variant-union constraint, but the
// runtime values are correct — suppress to preserve full inference.
export type ChatAgentT = ToolLoopAgent<never, typeof chatTools>;
export type ChatUIMessage = InferAgentUIMessage<ChatAgentT>;

/**
 * Spec §11.2/§14.5/§15.18 — the operator kill switch. Reuses the adapter's
 * closed error mapping so the chat path, the management routes, and the
 * adapter cannot drift on the status/message an operator sees.
 */
const WEB_SESSION_FEATURE_DISABLED = ERROR_MAPPING.feature_disabled;

/** Spec §6/§10 — a missing or non-verified session is an actionable 401. */
const WEB_SESSION_REQUIRED_MESSAGE =
  "DeepSeek Web session expired or was rejected. Re-import the session token to continue.";

/**
 * Spec §8.5 — a verified session whose model data is older than the stale
 * window is unusable, but the fix is a model refresh, not a token re-import,
 * so it gets its own actionable message rather than the credential one.
 */
const WEB_SESSION_STALE_MESSAGE =
  "DeepSeek Web model data is stale. Refresh the discovered models in Settings → Providers to continue.";

/**
 * True when the session's discovered model data has aged past the 24h stale
 * window (Spec §8.5). `lastCheckedAt` is the last successful revalidation;
 * `capturedAt` is the import time, used before the first revalidation. A
 * session with neither has no freshness evidence and is treated as stale.
 */
function isWebSessionStale(session: WebProviderSession): boolean {
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  const lastActive = session.lastCheckedAt?.getTime() ?? session.capturedAt?.getTime() ?? 0;
  return Date.now() - lastActive > currentEnv.YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS;
}

/**
 * Reads the flag through `refreshEnv()` under test so a suite can flip it
 * (`vi.stubEnv`) without re-importing this module — the pattern established by
 * `src/app/api/projects/guard.ts` and `src/lib/security/ssrf.ts`.
 */
function webSessionFeatureDisabledResponse(): Response | null {
  const currentEnv = env.NODE_ENV === "test" ? refreshEnv() : env;
  if (currentEnv.YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS) return null;
  return new Response(WEB_SESSION_FEATURE_DISABLED.message, {
    status: WEB_SESSION_FEATURE_DISABLED.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function webSessionRequiredResponse(): Response {
  return new Response(WEB_SESSION_REQUIRED_MESSAGE, {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function webSessionStaleResponse(): Response {
  return new Response(WEB_SESSION_STALE_MESSAGE, {
    status: 401,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(req: Request) {
  // Ensure background queue and cognitive loop handlers are bootstrapped
  bootstrapAutonomousCognitiveSystem();

  let body: {
    messages?: UIMessage[];
    model?: string;
    chatId?: string;
    effort?: ReasoningEffortTier | "auto";
    /**
     * Model-visible history the client already bounded to a token budget
     * (`compactAndPruneMessages` on its side). When present the guard runs
     * on this list instead of the full transcript, so a long chat is not
     * re-compacted and re-summarized on every request. Falls back to
     * `messages` (full) when absent (legacy clients / first turn).
     */
    modelContextMessages?: UIMessage[];
    clientLocation?: {
      latitude: number;
      longitude: number;
      accuracy?: number;
      altitude?: number | null;
      heading?: number | null;
      speed?: number | null;
    };
    clientTimezone?: string;
  };
  try {
    body = await req.json();
  } catch (err) {
    syslog(
      "debug",
      "chat",
      `Request body JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new Response("Invalid JSON in request body.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const model = typeof body?.model === "string" ? body.model : undefined;
  const chatId = typeof body?.chatId === "string" ? body.chatId : undefined;
  const requestedEffort = body?.effort ?? "auto";
  // NOTE: a client-sent `provider` field is deliberately ignored — the
  // registry is the single source of truth for provider credentials and
  // base URLs; nothing a request body carries can override either.

  // Registry-backed model resolution (provider-config SSOT): a request
  // names a model ref ("modelId" or a bare id — the qualified form is
  // decoded client-side before the call); the server resolves it against
  // its own registry. A stale ref fails fast with a named entity instead
  // of an opaque upstream 404, and provider credentials never cross the
  // wire from the client.
  let resolvedModelId: string;
  let resolvedModelEntry: ModelEntry | undefined;
  let resolvedProviderName: string | undefined;
  let resolved: ReturnType<typeof chatModelForEntry>;
  try {
    if (model) {
      const { modelId, providerId } = decodeModelRef(model);
      const doc = await loadRegistry();
      const provider = doc.providers.find((p) => p.id === providerId);
      if (!provider) {
        return new Response(`Provider "${providerId}" not found`, {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const foundModel = provider.models.find((m) => m.modelId === modelId);
      if (!modelId || !foundModel) {
        return new Response(
          `Model "${modelId ?? model}" not found in provider "${provider.name}"`,
          {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        );
      }
      resolvedModelId = modelId;
      resolvedModelEntry = foundModel;
      resolvedProviderName = provider.name;
      // Web-session providers (DeepSeek Web) authenticate with a
      // browser-captured session, not an API key: resolve no key and gate on
      // a verified session instead. A missing/expired session is an
      // actionable 401 — never a silent empty stream. On success the request
      // continues down the ordinary tool/context/persistence path.
      if (provider.kind === "web-session") {
        const featureDisabled = webSessionFeatureDisabledResponse();
        if (featureDisabled) return featureDisabled;
        const session = await getWebSession(provider.id);
        if (!session || session.status !== "verified") {
          return webSessionRequiredResponse();
        }
        if (isWebSessionStale(session)) {
          return webSessionStaleResponse();
        }
        resolved = chatModelForEntry(modelId, provider, undefined, session);
      } else {
        const apiKey =
          provider.kind === "ollama" ? undefined : await resolveApiKey(provider);
        // Spec §6: a missing key is a named, actionable error — never a
        // generic upstream auth failure.
        if (provider.kind !== "ollama" && provider.apiKeyEnv && !apiKey) {
          return new Response(
            `API key not set for ${provider.name} (${provider.apiKeyEnv})`,
            {
              status: 400,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
          );
        }
        resolved = chatModelForEntry(modelId, provider, apiKey);
      }
    } else {
      const def = await getDefaultModelEntry();
      if (!def) {
        return new Response(
          "No default model configured — add a provider and model in Settings → Providers.",
          {
            status: 400,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }
        );
      }
      resolvedModelId = def.model.modelId;
      resolvedModelEntry = def.model;
      resolvedProviderName = def.provider.name;
      // Same web-session gate as the explicit-model branch: a web-session
      // default model must not fall through to API-key resolution.
      if (def.provider.kind === "web-session") {
        const featureDisabled = webSessionFeatureDisabledResponse();
        if (featureDisabled) return featureDisabled;
        const session = await getWebSession(def.provider.id);
        if (!session || session.status !== "verified") {
          return webSessionRequiredResponse();
        }
        if (isWebSessionStale(session)) {
          return webSessionStaleResponse();
        }
        resolved = chatModelForEntry(
          def.model.modelId,
          def.provider,
          undefined,
          session
        );
      } else {
        const apiKey =
          def.provider.kind === "ollama"
            ? undefined
            : await resolveApiKey(def.provider);
        if (def.provider.kind !== "ollama" && def.provider.apiKeyEnv && !apiKey) {
          return new Response(
            `API key not set for ${def.provider.name} (${def.provider.apiKeyEnv})`,
            {
              status: 400,
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            }
          );
        }
        resolved = chatModelForEntry(def.model.modelId, def.provider, apiKey);
      }
    }
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      // Spec §6: a broken registry (missing file, corrupt JSON) fails
      // with the named path + issue — never a generic 500, and never any
      // secret material (ProviderConfigError messages carry neither).
      return new Response(
        `Provider registry unavailable: ${(err as Error).message}`,
        {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }
      );
    }
    throw err;
  }

  // Resumable-stream prerequisite + tool/attachment gathering executed in parallel:
  // - Pre-stream chat row creation (persistence)
  // - Message attachment decoding
  // - MCP tool collection
  // - Subagent tool building
  let isNewSession = false;
  let priorChatTitle: string | undefined;
  let priorPinned: boolean | undefined;

  const preStreamChatPromise = chatId
    ? (async () => {
        try {
          const existing = await getChatDb(chatId);
          if (!existing || existing.messages.length === 0) {
            isNewSession = true;
            const existingTitle = existing?.title;
            const hasEstablishedPreTitle =
              Boolean(existingTitle) &&
              existingTitle !== "Untitled chat" &&
              existingTitle !== "New chat";
            priorChatTitle = hasEstablishedPreTitle ? existingTitle : undefined;
            priorPinned = existing?.pinned;

            await saveChatDb({
              id: chatId,
              title: hasEstablishedPreTitle ? existingTitle! : deriveTitle(messages),
              updatedAt: Date.now(),
              messages,
              pinned: existing?.pinned,
            });
          } else {
            priorChatTitle = existing.title;
            priorPinned = existing.pinned;
          }
        } catch (err) {
          console.warn("[chat/route] Pre-stream chat row creation failed:", err);
        }
      })()
    : Promise.resolve();

  const [processedMessages, mcpResult, subagentToolEntriesResult] =
    await Promise.all([
      processIncomingMessageAttachments(messages),
      collectMcpTools().catch((err) => {
        console.warn("[chat/route] MCP tool collection failed:", err);
        return undefined;
      }),
      buildSubagentToolsForChat()
        .then((items) => items.map(({ name, tool }) => ({ [name]: tool })))
        .catch((err) => {
          console.warn("[chat/route] Subagent tool build failed:", err);
          return [] as Array<Record<string, unknown>>;
        }),
      preStreamChatPromise,
    ]);

  const mcp = mcpResult;
  const subagentToolEntries = subagentToolEntriesResult;

  const lastUserMessage = messages
    .filter((m) => m.role === "user")
    .at(-1)
    ?.parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");

  // Topic handoff: detect if the user message shifts to a new topic
  // relative to recent conversation. When it does, a semantic boundary
  // marker is written so compaction/reflection start a fresh summary
  // instead of carrying old-topic context forward.
  if (lastUserMessage && chatId) {
    void detectAndMarkTopicShift(chatId, lastUserMessage).catch((err) => {
      syslog("warn", "memory", `Topic handoff detection failed: ${err}`);
    });
  }

  // Sandbox workspace tools (bash, readFile, writeFile) confined to
  // data/sandbox. Construction is synchronous and cannot fail.
  //
  // The device-location tool is rebuilt per request bound to this chat's id,
  // so it reads only the GPS fix this chat reported rather than a global
  // "latest location" that any other chat could have set.
  const baseTools = {
    ...chatTools,
    ...createSandboxTools(),
    get_device_location: createGetDeviceLocationTool(chatId),
  };
  const subagentTools = Object.assign({}, ...subagentToolEntries) as Record<
    string,
    unknown
  >;

  const customTools = buildCustomToolsForChat();
  const safeCustomTools = Object.fromEntries(
    Object.entries(customTools).filter(([name]) => {
      if (name in baseTools || name in subagentTools) {
        syslog(
          "warn",
          "custom-tools",
          `Dropped custom tool '${name}' colliding with base/subagent tool.`
        );
        return false;
      }
      return true;
    })
  );

  // Final merged toolset, then the per-tool toggle policy has the last
  // word: any tool the user disabled in Settings → Tools is removed from
  // the model-visible set for this request.
  //
  // The spread of chatTools (skill + builtin tools) doesn't structurally
  // satisfy ToolSet's variant-union constraint — the same variance gap
  // documented at the ChatAgentT type above; the runtime values are
  // correct. Cast at this single merge point so the policy filter and
  // every downstream consumer typecheck against the real ToolSet.
  const mergedTools = {
    ...baseTools,
    ...subagentTools,
    ...safeCustomTools,
    ...(mcp
      ? // Defense-in-depth: collectMcpTools already withholds MCP tools
        // whose underlying name duplicates a built-in, but if a
        // slug-prefixed name still collides with a local key, the local
        // tool wins.
        Object.fromEntries(
          Object.entries(mcp.tools).filter(
            ([name]) =>
              !(name in baseTools) &&
              !(name in subagentTools) &&
              !(name in safeCustomTools)
          )
        )
      : {}),
  } as unknown as ToolSet;

  const tools = filterToolsForChat(mergedTools);

  // Resolve capability fallbacks via known model heuristics when not explicitly
  // configured in the registry document (e.g. unconfigured context limits).
  const inferredCaps = inferKnownModelCapabilities(resolvedModelId);
  const effectiveContextWindow =
    resolvedModelEntry?.capabilities?.contextWindow ??
    inferredCaps?.contextWindow ??
    null;
  const effectiveMaxOutput =
    resolvedModelEntry?.capabilities?.maxOutputTokens ??
    inferredCaps?.maxOutputTokens ??
    null;
  const effectiveSupportsReasoning =
    resolvedModelEntry?.capabilities?.supportsReasoning ??
    inferredCaps?.supportsReasoning ??
    null;
  const effectiveSupportsToolCalls =
    resolvedModelEntry?.capabilities?.supportsToolCalls ??
    inferredCaps?.supportsToolCalls ??
    null;

  let deviceLocation: ResolvedLocation | undefined;
  if (body?.clientLocation && typeof body.clientLocation.latitude === "number") {
    deviceLocation = {
      success: true,
      source: "device_gps",
      coordinates: {
        latitude: body.clientLocation.latitude,
        longitude: body.clientLocation.longitude,
        accuracyMeters: body.clientLocation.accuracy,
        altitudeMeters: body.clientLocation.altitude,
        headingDegrees: body.clientLocation.heading,
        speedMps: body.clientLocation.speed,
      },
      timezone: body.clientTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      timestamp: new Date().toISOString(),
    };
    if (chatId) {
      setChatDeviceLocation(chatId, deviceLocation);
    }
  } else if (chatId) {
    deviceLocation = getChatDeviceLocation(chatId);
  }

  const systemPrompt = await synthesizeSystemPrompt({
    userQuery: lastUserMessage,
    activeTools: Object.keys(tools),
    deviceLocation,
    modelContext: {
      modelId: resolvedModelId,
      displayName: resolvedModelEntry?.displayName,
      providerName: resolvedProviderName,
      contextWindow: effectiveContextWindow,
      maxOutputTokens: effectiveMaxOutput,
      supportsReasoning: effectiveSupportsReasoning,
      supportsToolCalls: effectiveSupportsToolCalls,
    },
  });

  const fullSystemPrompt = mcp?.instructions
    ? `${systemPrompt}\n\n${mcp.instructions}`
    : systemPrompt;

  // Dynamic context budgeting & reasoning pipeline:
  // Proactive task-adaptive reasoning effort resolution:
  // If effort is "auto" (or omitted), classify the task using semantic heuristics, tool signals, and memory rules
  let resolvedEffort: ReasoningEffortTier;
  if (requestedEffort === "auto") {
    const { rules: learnedRules, preferences: userPreferences } =
      await extractLearnedRulesAndPreferences();
    resolvedEffort = classifyTaskReasoningEffort(lastUserMessage ?? "", {
      activeTools: Object.keys(tools),
      learnedRules,
      userPreferences,
    });
    syslog(
      "info",
      "agent",
      `Task-adaptive reasoning auto-selected "${resolvedEffort}" effort for query "${(lastUserMessage ?? "").slice(0, 40)}"`
    );
  } else if (
    ["xhigh", "high", "medium", "low", "none"].includes(requestedEffort)
  ) {
    resolvedEffort = requestedEffort as ReasoningEffortTier;
  } else {
    resolvedEffort = "high";
  }

  // 1. Calculate monotonic reasoning output budget based on model output capabilities
  const { targetThinking, requestedOutputTokens } =
    calculateReasoningOutputBudget(
      resolvedEffort,
      effectiveMaxOutput
    );

  // 2. Measure system prompt & tools token footprint
  const systemAndToolsTokens = estimateTokens(fullSystemPrompt) + 2000;

  // 3. Calculate dynamic context budget with proportional output clamping.
  // Divide by the estimator's observed calibration ratio for this model:
  // when the provider counts more tokens than our ~4 chars/token
  // heuristic does (Indonesian/CJK prose, dense JSON), the guard
  // compacts earlier so the provider never rejects an over-limit prompt.
  const rawBudgetResult = calculateContextTokenBudget({
      contextWindow: effectiveContextWindow,
      requestedOutputTokens,
      systemAndToolsTokens,
    });
  const tokenRatio = getTokenRatio(resolvedModelId);
  const budgetTokens = Math.max(
    1_000,
    Math.floor(rawBudgetResult.budgetTokens / tokenRatio)
  );

  // 4. Reconcile thinking budget against effective output limit
  const { providerOptions } = reconcileThinkingBudget(
    rawBudgetResult.effectiveMaxOutputTokens,
    targetThinking,
    resolvedEffort,
    resolvedModelId
  );

  // 5. Compact and prune messages within dynamic token budget. When the
  // client pre-compacted this turn's history (modelContextMessages), the
  // guard runs on that bounded list and only drops again if it genuinely
  // outgrew the budget (model switch, toolset drift) — re-writing the
  // summary for the same dropped prefix on every request would otherwise
  // thrash long chats.
  const clientContext =
    Array.isArray(body.modelContextMessages) &&
    body.modelContextMessages.length > 0
      ? body.modelContextMessages
      : null;
  // Inject the rolling summary as context: prepend it as a
  // [Conversation Summary: ...] text block on the first user message so
  // the model always gets a recap of the conversation arc, even when the
  // full history fits within the token budget (no compaction triggered).
  // If compaction later drops messages, generateExtractiveSummary
  // recognizes and preserves this block, extending it with new content.
  let contextMessages = processedMessages;
  if (chatId) {
    const rollingSummary = await getRollingSummary(chatId);
    if (rollingSummary) {
      const firstUserIdx = contextMessages.findIndex(
        (m) => m.role === "user"
      );
      if (firstUserIdx !== -1) {
        const first = contextMessages[firstUserIdx];
        const summaryBlock = `[Conversation Summary:\n${rollingSummary.content}\n]`;
        contextMessages = [
          ...contextMessages.slice(0, firstUserIdx),
          {
            ...first,
            parts: [
              { type: "text", text: summaryBlock },
              ...first.parts,
            ],
          },
          ...contextMessages.slice(firstUserIdx + 1),
        ];
      }
    }
  }

  const contextBase = clientContext ?? contextMessages;
  // Decode text/code attachments in the model-visible list too (idempotent
  // on lists the client already processed) so the guard's token estimate
  // matches exactly what the provider receives.
  const processedContext = await processIncomingMessageAttachments(contextBase);
  const { messages: budgetedMessages, droppedCount } =
    compactAndPruneMessages(processedContext, budgetTokens);
  if (droppedCount > 0) {
    console.info(
      `[chat/route] Context guard compacted and pruned ${droppedCount} older messages to fit the ${budgetTokens} token budget.`
    );
  }

  // Estimator self-calibration input: the estimate of the full prompt we
  // are about to send (history + system + tools). The first finish-step's
  // real inputTokens is compared against this to correct the ~4 chars/token
  // heuristic for this model (see recordTokenRatio).
  const sentPromptEstimate =
    budgetedMessages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0
    ) + systemAndToolsTokens;

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
  let calibrationRecorded = false;

  // Request-scoped runtime context: flows through streamText lifecycle
  // callbacks (onStart/onStepEnd/onEnd), prepareStep, and step results so
  // telemetry/policy code can correlate a generation to its chatId, modelId,
  // and feature flags without reaching back into module-level state.
  const runtimeContext = buildRuntimeContext({
    chatId: chatId ?? generateId(),
    modelId: resolvedModelId,
  });

  try {
    const result = streamText({
      model: resolved,
      instructions: fullSystemPrompt,
      maxOutputTokens: rawBudgetResult.effectiveMaxOutputTokens,
      // Pass the live toolset so tool outputs (notably a delegate tool's
      // accumulated UIMessage) replay through toModelOutput as compressed
      // text on every later turn instead of JSON-serializing whole into
      // the model context (context overflow on long chats).
      //
      // ignoreIncompleteToolCalls: a tool call interrupted mid-flight (user
      // hits Stop, the browser refreshes, or a slow MCP server — parallel
      // search can take 30-90s — gets aborted) leaves its UI part in a
      // non-terminal state in the persisted history. Without this flag the
      // SDK throws MissingToolResultsError for that dangling call on every
      // later request in the chat; with it, unfinished calls are filtered
      // out of the model-visible history so the conversation continues.
      messages: await convertToModelMessages(budgetedMessages, {
        ignoreIncompleteToolCalls: true,
        tools,
      }),
      tools,
      providerOptions,
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
      runtimeContext,
      // Per-step model adaptation (AI SDK v7 prepareStep): after the
      // temperature-step threshold is crossed AND the previous step emitted
      // tool calls, lower the temperature for determinism, optionally swap
      // to a reasoning model, and withhold focused tools (e.g. "bash") to
      // keep the model on-track during deep tool chains. On every other
      // step the callback returns {} so the outer streamText settings
      // flow through unchanged.
      prepareStep: createPrepareStep({
        availableToolNames: Object.keys(tools),
      }),
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
      // HMAC-sign tool-approval requests so the server can verify that
      // approval responses replayed by the client were actually issued by
      // this server, preventing client-side forgery of approvals. The
      // existing toolApproval callback above is unchanged — this is an
      // additional security layer on top of it. The secret is a persisted
      // high-entropy value (generated on first boot, reused thereafter).
      experimental_toolApprovalSecret: await resolveApprovalSecret(),
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
        } catch (err) {
          syslog(
            "debug",
            "chat",
            `Tool input repair failed, returning null: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
        return null;
      },
      // Let the model run up to 15 steps so multi-tool work (search → fetch
      // → remember → artifact) does not hit the cap mid-task. The active
      // chat mutex keeps background jobs off the GPU meanwhile.
      stopWhen: createChatStopConditions(),
      experimental_transform: smoothStream({ chunking: "word", delayInMs: 2 }),
      // ── Lifecycle observability (AI SDK v7) ───────────────────────
      // Full callback surface wired into streamText. The deprecated
      // `onStepFinish` is replaced by `onStepEnd`
      // (docs/03-ai-sdk-core/65-lifecycle-callbacks.mdx). Callbacks that
      // carry timing/token data also record a structured metric via
      // recordAgentMetric (bounded ring buffer keyed by callId); the rest
      // emit syslog lines. syslog and recordAgentMetric swallow errors
      // internally, and the SDK isolates callback throws, so these never
      // jeopardize the generation path.
      onStart: ({ provider, modelId, messages }) => {
        syslog(
          "info",
          "agent",
          `Generation started: provider=${provider} model=${modelId} messages=${messages.length}`
        );
      },

      onStepStart: ({ callId, stepNumber, activeTools }) => {
        const toolNames = (activeTools ?? []).join(", ");
        syslog(
          "debug",
          "agent",
          `Step ${stepNumber} starting (call ${callId}); active tools: ${toolNames || "(none)"}`
        );
      },

      onLanguageModelCallStart: ({ callId, provider, modelId }) => {
        syslog(
          "debug",
          "agent",
          `Model call started: provider=${provider} model=${modelId} (call ${callId})`
        );
      },

      onLanguageModelCallEnd: ({
        callId,
        finishReason,
        usage,
        performance,
      }) => {
        const responseTimeMs = performance?.responseTimeMs ?? null;
        const throughput = performance?.outputTokensPerSecond ?? null;
        syslog(
          "debug",
          "agent",
          `Model call ended: finishReason=${finishReason} responseTimeMs=${responseTimeMs ?? "n/a"} outputTokensPerSec=${throughput ?? "n/a"} totalTokens=${usage?.totalTokens ?? 0}`
        );
        recordAgentMetric({
          callId,
          durationMs: responseTimeMs,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
          finishReason,
        });
      },

      onToolExecutionStart: ({ toolCall }) => {
        syslog(
          "debug",
          "agent",
          `Tool execution started: ${toolCall.toolName} (${toolCall.toolCallId})`
        );
      },

      onToolExecutionEnd: ({ callId, toolCall, toolExecutionMs, toolOutput }) => {
        const success = toolOutput.type === "tool-result";
        syslog(
          "info",
          "agent",
          `Tool execution finished: ${toolCall.toolName} (${toolCall.toolCallId}) durationMs=${toolExecutionMs} success=${success}`
        );
        recordAgentMetric({
          callId,
          toolName: toolCall.toolName,
          durationMs: toolExecutionMs,
        });
      },

      onStepEnd: ({
        callId,
        stepNumber,
        text,
        usage,
        finishReason,
        performance,
      }) => {
        // (a) Accumulate text for onEnd's ingest/job (previously onStepFinish).
        if (text) {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
        }
        // (b) First step's inputTokens is the full sent prompt — feed the
        // calibration so the next request's budget already accounts for the
        // estimator's error on this model. Later steps include prior step
        // output (content the estimate never counted), so only the first
        // step is a valid calibration point.
        if (
          !calibrationRecorded &&
          usage?.inputTokens &&
          usage.inputTokens > 0
        ) {
          calibrationRecorded = true;
          recordTokenRatio(
            resolvedModelId,
            sentPromptEstimate,
            usage.inputTokens
          );
        }
        // (c) Per-step token usage + finish reason. The per-tool timing that
        // was logged ad-hoc here previously now lives in
        // onToolExecutionStart/End; this logs the step's aggregate result.
        syslog(
          "debug",
          "agent",
          `Step ${stepNumber} finished: finishReason=${finishReason} totalTokens=${usage?.totalTokens ?? 0}`
        );
        recordAgentMetric({
          callId,
          stepNumber,
          durationMs: performance?.stepTimeMs ?? null,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
          finishReason,
        });
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
          // Update the rolling summary with this turn's content so the
          // next request always has a fresh recap available.
          if (lastUserMessage && chatId) {
            void updateRollingSummary(
              chatId,
              lastUserMessage,
              (text && text.trim().length > 0 ? text : accumulatedText).trim()
            ).catch((err) => {
              syslog("warn", "memory", `Rolling summary update failed: ${err}`);
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
        // Persistence mode: provide the originals so the SDK assigns a
        // stable message id to the response and hands back the full
        // updated list in onEnd.
        originalMessages: messages,
        generateMessageId: generateId,
        // Attach per-step token usage and resolved reasoning effort to the assistant message metadata
        messageMetadata: ({ part }) => {
          if (part.type === "finish-step") {
            return { usage: part.usage, reasoningEffort: resolvedEffort };
          }
          return undefined;
        },
        onError: (error) => {
          safeEndChatTracking();
          console.error("[chat] stream error:", error);
          const detail = formatErrorDetail(error);
          return `Request to model "${resolvedModelId}" failed: ${detail}`;
        },
        // Server-authoritative save (resumable-stream contract): the
        // client's settle-save remains for the live client, but a client
        // that died mid-stream (refresh, tab close, navigation) leaves
        // the finished turn in the database anyway.
        onEnd: async ({ messages: finalMessages }) => {
          if (chatId && finalMessages.length > 0) {
            // Re-read current row to avoid clobbering concurrent user renames or pin toggles
            const currentDb = await getChatDb(chatId).catch(() => null);
            const liveTitle = currentDb?.title;
            const livePinned = currentDb?.pinned ?? priorPinned;

            const effectivePriorTitle = liveTitle ?? priorChatTitle;
            const hasEstablishedTitle =
              Boolean(effectivePriorTitle) &&
              effectivePriorTitle !== "Untitled chat" &&
              effectivePriorTitle !== "New chat";

            const deterministicTitle = hasEstablishedTitle
              ? effectivePriorTitle!
              : deriveTitle(finalMessages);

            try {
              const saved = await saveChatDb(
                {
                  id: chatId,
                  title: deterministicTitle,
                  updatedAt: Date.now(),
                  messages: finalMessages,
                  pinned: livePinned,
                },
                undefined,
                currentDb ? { ifUpdatedAt: currentDb.updatedAt } : undefined,
              );

              // Best-effort AI-generated title refinement: gate on `saved` to
              // avoid overwriting a concurrent rename (Rule 17: no TOCTOU).
              if (saved && isNewSession && !hasEstablishedTitle) {
                void (async () => {
                  try {
                    const title = await generateChatTitle(finalMessages, resolved, {
                      fallback: deterministicTitle,
                    });
                    if (title && title !== deterministicTitle) {
                      // Check whether user renamed the title in the meantime
                      const latest = await getChatDb(chatId).catch(() => null);
                      if (
                        latest &&
                        latest.title !== deterministicTitle &&
                        latest.title !== "Untitled chat" &&
                        latest.title !== "New chat"
                      ) {
                        return; // User set a custom title; don't overwrite
                      }

                      await saveChatDb({
                        id: chatId,
                        title,
                        updatedAt: Date.now(),
                        messages: finalMessages,
                        pinned: latest?.pinned ?? livePinned,
                      });
                    }
                  } catch (err) {
                    syslog(
                      "debug",
                      "chat",
                      `Background title refinement failed: ${err instanceof Error ? err.message : String(err)}`
                    );
                  }
                })();
              }
            } catch (err) {
              console.warn("[chat/route] Server-side settle save failed:", err);
            }
            // Clear the resume pointer so a later GET does not answer
            // with a dead stream (the registry entry self-removed).
            await clearActiveStreamIdDb(chatId).catch((err) => {
              syslog(
                "debug",
                "chat",
                `Failed to clear active stream id: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }
        },
      }),
      headers: {
        "x-reasoning-effort": resolvedEffort,
        // Report the exact budget the guard enforces so the client's next
        // pre-send compaction (modelContextMessages) targets the same
        // number. Once caught up, the guard drops nothing and stays
        // silent — this header is the convergence channel.
        "x-context-budget": String(budgetTokens),
        "x-context-dropped": String(droppedCount),
        // Report the effective context window (resolved from registry or
        // heuristics, with the 24k fallback applied server-side) so the
        // client's display percentage matches what the server actually
        // budgets against — eliminating the 128K-vs-24K display mismatch.
        "x-context-window": String(rawBudgetResult.effectiveWindow),
        // Publish MCP App info so the client can fall back to
        // resourceUri-based serverId resolution when tool metadata
        // doesn't carry an embedded serverId (backward compatibility).
        ...(mcp?.apps ? { "x-mcp-apps": JSON.stringify(mcp.apps) } : {}),
      },
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
