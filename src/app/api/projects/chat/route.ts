import { NextResponse } from "next/server";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  InvalidToolInputError,
  smoothStream,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  createHarnessLoop,
  createHarnessPrepareStep,
  createHarnessStopConditions,
  formatHarnessRunEndLog,
  formatTimeoutForClient,
  HARNESS_BASH_TIMEOUT_MS,
  HARNESS_TIMEOUT,
} from "@/lib/ai/harness-loop";
import {
  harnessHistoryBudget,
  harnessToolOutputChars,
} from "@/lib/ai/harness-context";
import { validateProjectApiRequest } from "../guard";
import {
  getProject,
  getProjectSession,
  saveProjectSession,
  claimProjectSessionStream,
  releaseProjectSessionStream,
  resolveCanonicalProjectPath,
} from "@/lib/project-service";
import {
  streamRegistry,
  publishStream,
} from "@/lib/ai/stream-registry";
import { createProjectHarnessTools } from "@/lib/project-harness-tools";
import { collectMcpTools } from "@/lib/ai/mcp/manager";
import { synthesizeProjectSystemPrompt } from "@/lib/ai/project-prompt";
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
import { decodeModelRef } from "@/lib/settings";
import { formatErrorDetail } from "@/lib/ai/errors";
import { processIncomingMessageAttachments } from "@/lib/ai/attachments";
import {
  compactAndPruneMessages,
  calculateContextTokenBudget,
  estimateTokens,
  estimateMessageTokens,
  getTokenRatio,
  recordTokenRatio,
} from "@/lib/ai/context-budget";
import { inferKnownModelCapabilities } from "@/lib/ai/model-heuristics";
import {
  calculateReasoningOutputBudget,
  classifyTaskReasoningEffort,
  reconcileThinkingBudget,
  type ReasoningEffortTier,
} from "@/lib/ai/reasoning";
import { extractLearnedRulesAndPreferences } from "@/lib/ai/prompt";
import { evaluateToolApproval } from "@/lib/ai/tool-policy";
import { resolveApprovalSecret } from "@/lib/ai/approval-secret";
import { repairToolCallInput } from "@/lib/ai/tool-repair";
import { buildRuntimeContext } from "@/lib/ai/runtime-context";
import { secureFetch } from "@/lib/security/ssrf";
import { chatActiveTracker } from "@/lib/queue/tracker";
import { syslog, recordAgentMetric } from "@/lib/observability/log-store";
import { getRollingSummary, updateRollingSummary } from "@/lib/memory/rolling-summary";
import { detectAndMarkTopicShift } from "@/lib/memory/topic-handoff";

export const dynamic = "force-dynamic";

function clearActiveSessionStream(sessionId: string, activeStreamId: string) {
  try {
    releaseProjectSessionStream(sessionId, activeStreamId);
  } catch (err) {
    console.warn("[projects/chat] Failed to clear active session stream:", err);
  }
}

export async function POST(req: Request) {
  const guardResponse = validateProjectApiRequest(req, { requireJsonBody: true });
  if (guardResponse) return guardResponse;

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    console.debug(`[route] Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    projectId,
    sessionId,
    messages,
    model,
    effort,
  } = body as Record<string, unknown>;

  if (typeof projectId !== "string" || !projectId.trim()) {
    return NextResponse.json(
      { error: "projectId is required" },
      { status: 400 }
    );
  }

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return NextResponse.json(
      { error: "sessionId is required" },
      { status: 400 }
    );
  }

  const project = await getProject(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const session = await getProjectSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.projectId !== projectId) {
    return NextResponse.json(
      { error: "Session does not belong to project" },
      { status: 400 }
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await resolveCanonicalProjectPath(project.directoryPath);
  } catch (err) {
    console.debug(`[route] Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: "Project directory no longer exists on disk" },
      { status: 404 }
    );
  }

  // Check for in-flight stream (cheap client-side guard; the authoritative
  // check is the atomic claimProjectSessionStream below which closes the
  // TOCTOU window between read and save).
  if (session.activeStreamId && streamRegistry.has(session.activeStreamId)) {
    return NextResponse.json(
      { error: "Session stream is already in progress" },
      { status: 409 }
    );
  }

  let resolvedModelId: string;
  let resolvedModelEntry: ModelEntry | undefined;
  let resolved: ReturnType<typeof chatModelForEntry>;

  try {
    if (typeof model === "string" && model.trim()) {
      const { modelId, providerId } = decodeModelRef(model);
      const doc = await loadRegistry();
      const provider = doc.providers.find((p) => p.id === providerId);
      if (!provider) {
        return NextResponse.json(
          { error: `Provider "${providerId}" not found` },
          { status: 400 }
        );
      }
      const foundModel = provider.models.find((m) => m.modelId === modelId);
      if (!modelId || !foundModel) {
        return NextResponse.json(
          { error: `Model "${modelId ?? model}" not found in provider "${provider.name}"` },
          { status: 400 }
        );
      }
      resolvedModelId = modelId;
      resolvedModelEntry = foundModel;
      const apiKey =
        provider.kind === "ollama" ? undefined : await resolveApiKey(provider);
      if (provider.kind !== "ollama" && provider.apiKeyEnv && !apiKey) {
        return NextResponse.json(
          { error: `API key not set for ${provider.name} (${provider.apiKeyEnv})` },
          { status: 400 }
        );
      }
      resolved = chatModelForEntry(modelId, provider, apiKey);
    } else {
      const def = await getDefaultModelEntry();
      if (!def) {
        return NextResponse.json(
          { error: "No default model configured — add a provider and model in Settings → Providers." },
          { status: 400 }
        );
      }
      resolvedModelId = def.model.modelId;
      resolvedModelEntry = def.model;
      const apiKey =
        def.provider.kind === "ollama"
          ? undefined
          : await resolveApiKey(def.provider);
      if (def.provider.kind !== "ollama" && def.provider.apiKeyEnv && !apiKey) {
        return NextResponse.json(
          { error: `API key not set for ${def.provider.name} (${def.provider.apiKeyEnv})` },
          { status: 400 }
        );
      }
      resolved = chatModelForEntry(def.model.modelId, def.provider, apiKey);
    }
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      return NextResponse.json(
        { error: `Provider registry unavailable: ${err.message}` },
        { status: 500 }
      );
    }
    throw err;
  }

  // The harness is a tool-calling loop: without tool calling the model can
  // only chat, which is exactly the failure mode this route exists to avoid.
  // The registry exposes supportsToolCalls per model; only an explicit
  // `false` blocks the request (null = unknown, so we let it through).
  if (resolvedModelEntry?.capabilities?.supportsToolCalls === false) {
    return NextResponse.json(
      {
        error: `Model "${resolvedModelId}" does not support tool calling, which the project harness requires. Choose a tool-capable model in Settings → Providers.`,
      },
      { status: 400 }
    );
  }

  const projectTools = createProjectHarnessTools({
    projectDirectory: project.directoryPath,
    canonicalRoot,
    trusted: project.trusted,
    timeoutMs: HARNESS_BASH_TIMEOUT_MS,
    // Window-aware tool output caps. The thunk is called at tool-execution
    // time, after `budgetTokens` below is initialized: the tools are built
    // first because `combinedTools` feeds the `effort: "auto"` classification
    // that feeds the budget. `budgetTokens` is a `const` in this function
    // scope, so the closure can only observe it once assigned (no TDZ read
    // happens before initialization).
    maxOutputChars: () => harnessToolOutputChars(budgetTokens),
  });

  const mcp = await collectMcpTools().catch((err) => {
    console.warn("[projects/chat] MCP tool collection failed:", err);
    return undefined;
  });

  const combinedTools: ToolSet = {
    ...projectTools,
    ...(mcp
      ? Object.fromEntries(
          Object.entries(mcp.tools).filter(([name]) => !(name in projectTools))
        )
      : {}),
  } as unknown as ToolSet;

  const rawMessages = Array.isArray(messages) ? (messages as UIMessage[]) : [];
  const processedMessages = await processIncomingMessageAttachments(rawMessages);

  const inferredCaps = inferKnownModelCapabilities(resolvedModelId);
  const effectiveContextWindow =
    resolvedModelEntry?.capabilities?.contextWindow ??
    inferredCaps?.contextWindow ??
    null;
  const effectiveMaxOutput =
    resolvedModelEntry?.capabilities?.maxOutputTokens ??
    inferredCaps?.maxOutputTokens ??
    null;

  // Compute lastUserMessage before the budget pipeline so it is available
  // for topic-shift detection and rolling-summary update in onEnd.
  const lastUserMessage =
    rawMessages
      .findLast((m) => m.role === "user")
      ?.parts?.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n") ?? "";

  // Topic handoff: detect if the user message shifts to a new topic
  // relative to recent conversation. When it does, a semantic boundary
  // marker is written so compaction/reflection start a fresh summary
  // instead of carrying old-topic context forward.
  if (lastUserMessage && sessionId) {
    void detectAndMarkTopicShift(sessionId, lastUserMessage).catch((err) => {
      syslog("warn", "memory", `Topic handoff detection failed: ${err}`);
    });
  }

  // Resolve reasoning effort: "auto" classifies the task using semantic
  // heuristics, tool signals, and memory rules; otherwise use the requested
  // tier (defaulting to "xhigh" for the agentic harness).
  let resolvedEffort: ReasoningEffortTier;
  if (effort === "auto") {
    const { rules: learnedRules, preferences: userPreferences } =
      await extractLearnedRulesAndPreferences();
    resolvedEffort = classifyTaskReasoningEffort(lastUserMessage, {
      activeTools: Object.keys(combinedTools),
      learnedRules,
      userPreferences,
    });
    syslog(
      "info",
      "agent",
      `Task-adaptive reasoning auto-selected "${resolvedEffort}" effort for query "${lastUserMessage.slice(0, 40)}"`
    );
  } else if (
    typeof effort === "string" &&
    ["xhigh", "high", "medium", "low", "none"].includes(effort)
  ) {
    resolvedEffort = effort as ReasoningEffortTier;
  } else {
    resolvedEffort = "xhigh";
  }

  const systemPrompt = await synthesizeProjectSystemPrompt(project);
  const approvalSecret = await resolveApprovalSecret();

  // 1. Calculate monotonic reasoning output budget based on model output capabilities
  const { targetThinking, requestedOutputTokens } = calculateReasoningOutputBudget(
    resolvedEffort,
    effectiveMaxOutput
  );

  // 2. Measure system prompt & tools token footprint
  const systemAndToolsTokens = estimateTokens(systemPrompt) + 2000;

  // 3. Calculate dynamic context budget with proportional output clamping.
  // Divide by the estimator's observed calibration ratio for this model:
  // when the provider counts more tokens than our ~4 chars/token heuristic
  // does, the guard compacts earlier so the provider never rejects an
  // over-limit prompt.
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

  // 5. Inject rolling summary: prepend a [Conversation Summary: ...] text
  // block on the first user message so the model always gets a recap of
  // the conversation arc, even when the full history fits within the
  // token budget (no compaction triggered).
  let contextMessages = processedMessages;
  const rollingSummary = await getRollingSummary(sessionId);
  if (rollingSummary) {
    const firstUserIdx = contextMessages.findIndex((m) => m.role === "user");
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

  // 6. Compact and prune messages to the harness history budget.
  // The harness runs up to HARNESS_MAX_STEPS steps in one streamText call and
  // appends every tool result to the prompt on every step, so filling history
  // to the full budget would leave no headroom. Reserve room with
  // HARNESS_HISTORY_BUDGET_RATIO; the in-run guard (harness-context.ts) then
  // elides stale tool output against the full budgetTokens.
  const harnessHistoryBudgetTokens = harnessHistoryBudget(budgetTokens);
  const { messages: budgetedMessages, droppedCount } =
    compactAndPruneMessages(contextMessages, harnessHistoryBudgetTokens);
  if (droppedCount > 0) {
    syslog(
      "info",
      "agent",
      `Context guard compacted and pruned ${droppedCount} older messages to fit the ${harnessHistoryBudgetTokens} token harness history budget.`,
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

  // Accumulators used by onStepEnd / onEnd for text aggregation and
  // self-calibration (first-step-only).
  let accumulatedText = "";
  let calibrationRecorded = false;

  // Context-guard telemetry for the run-end log (see prepareStep below).
  let contextElisions = 0;
  let contextWrapUp = false;

  // Request-scoped runtime context: flows through streamText lifecycle
  // callbacks, prepareStep, and step results so telemetry/policy code can
  // correlate a generation to its sessionId, modelId, and feature flags
  // without reaching back into module-level state.
  const runtimeContext = buildRuntimeContext({
    chatId: sessionId,
    modelId: resolvedModelId,
  });

  const activeStreamId = generateId();

  // Atomically claim the stream via a conditional UPDATE
  // (active_stream_id IS NULL). If another concurrent request already
  // set a non-null activeStreamId, this affects 0 rows → 409 Conflict.
  // This eliminates the TOCTOU window between the read-check above and
  // the save — Spec §4.3: "At most 1 active LLM generation stream per
  // project_session."
  //
  // `streamRegistry.has` reconciles a stale pointer: active_stream_id is a
  // resume pointer into the in-process registry, so after a restart (or a
  // crash that skipped onEnd) the row keeps an id the registry no longer
  // knows. Without reconciliation the session would 409 forever.
  if (
    !claimProjectSessionStream(sessionId, activeStreamId, undefined, (id) =>
      streamRegistry.has(id)
    )
  ) {
    return NextResponse.json(
      { error: "Session stream is already in progress" },
      { status: 409 }
    );
  }

  try {
    // No pre-stream saveProjectSession — persistence moves to
    // toUIMessageStream.onEnd and onAbort/catch. The pre-stream save wrote
    // activeStreamId: undefined before the stream started, breaking the
    // atomic claim and creating a race where a concurrent request could
    // claim the same stream.
    const result = createHarnessLoop({
      model: resolved,
      instructions: systemPrompt,
      maxOutputTokens: rawBudgetResult.effectiveMaxOutputTokens,
      maxRetries: 2,
      timeout: HARNESS_TIMEOUT,
      messages: await convertToModelMessages(budgetedMessages, {
        ignoreIncompleteToolCalls: true,
        tools: combinedTools,
      }),
      tools: combinedTools,
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
      // Per-step policy (AI SDK v7 prepareStep): the harness never withholds
      // tools and never changes the temperature — `bash` must stay available
      // at every step for the Verification Gate. Two interventions remain:
      //
      // 1. Context guard (harness-context.ts): once the prompt passes 80% of
      //    `budgetTokens`, stale tool output is elided toward 55%; if it is
      //    still above 95% the run is forced to wrap up with a status report.
      //    A returned `messages` override carries forward, so elision is
      //    cumulative and already-elided outputs are never re-processed.
      // 2. On the last permitted step (HARNESS_MAX_STEPS) the policy forces
      //    toolChoice "none" plus a wrap-up instruction so a capped run
      //    reports status instead of ending silently mid-task.
      prepareStep: createHarnessPrepareStep({
        contextBudgetTokens: budgetTokens,
        // Attribute a context wrap-up in the run-end log: it finishes with
        // finishReason=stop and fewer than HARNESS_MAX_STEPS steps, which is
        // otherwise indistinguishable from a natural stop.
        onContextGuard: (event) => {
          if (event.action === "elide") {
            contextElisions += 1;
          } else {
            contextWrapUp = true;
          }
        },
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
      // this server, preventing client-side forgery of approvals.
      experimental_toolApprovalSecret: approvalSecret,
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
              `Repaired tool input for ${toolCall.toolName} (schema coercion)`,
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
      // The harness stops only on its own step cap (HARNESS_MAX_STEPS); it has
      // no `ask_user_question` tool, so the chat stop conditions (15 steps +
      // that tool call) must not be reused here. The active chat mutex keeps
      // background jobs off the GPU meanwhile.
      stopWhen: createHarnessStopConditions(),
      experimental_transform: smoothStream({ chunking: "word", delayInMs: 2 }),
      // ── Lifecycle observability (AI SDK v7) ───────────────────────
      // Full callback surface wired into streamText. Callbacks that carry
      // timing/token data also record a structured metric via
      // recordAgentMetric (bounded ring buffer keyed by callId); the rest
      // emit syslog lines. syslog and recordAgentMetric swallow errors
      // internally, and the SDK isolates callback throws, so these never
      // jeopardize the generation path.
      onStart: ({ provider, modelId, messages }) => {
        syslog(
          "info",
          "agent",
          `Generation started: provider=${provider} model=${modelId} messages=${messages.length}`,
        );
      },

      onStepStart: ({ callId, stepNumber, activeTools }) => {
        const toolNames = (activeTools ?? []).join(", ");
        syslog(
          "debug",
          "agent",
          `Step ${stepNumber} starting (call ${callId}); active tools: ${toolNames || "(none)"}`,
        );
      },

      onLanguageModelCallStart: ({ callId, provider, modelId }) => {
        syslog(
          "debug",
          "agent",
          `Model call started: provider=${provider} model=${modelId} (call ${callId})`,
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
          `Model call ended: finishReason=${finishReason} responseTimeMs=${responseTimeMs ?? "n/a"} outputTokensPerSec=${throughput ?? "n/a"} totalTokens=${usage?.totalTokens ?? 0}`,
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
          `Tool execution started: ${toolCall.toolName} (${toolCall.toolCallId})`,
        );
      },

      onToolExecutionEnd: ({ callId, toolCall, toolExecutionMs, toolOutput }) => {
        const success = toolOutput.type === "tool-result";
        syslog(
          "info",
          "agent",
          `Tool execution finished: ${toolCall.toolName} (${toolCall.toolCallId}) durationMs=${toolExecutionMs} success=${success}`,
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
        // (a) Accumulate text for onEnd's rolling summary update.
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
        // (c) Per-step token usage + finish reason.
        syslog(
          "debug",
          "agent",
          `Step ${stepNumber} finished: finishReason=${finishReason} totalTokens=${usage?.totalTokens ?? 0}`,
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
      onEnd: async ({ text, steps, finishReason }) => {
        safeEndChatTracking();
        await mcp?.close();
        // Run-end observability: the harness loop has no per-turn summary
        // line, so a capped run (which forces a text wrap-up) would
        // otherwise be indistinguishable from a natural stop in the logs.
        const totalSteps = steps.length;
        syslog(
          "info",
          "agent",
          formatHarnessRunEndLog({
            steps: totalSteps,
            finishReason,
            contextElisions,
            contextWrapUp,
          }),
        );
        try {
          const finalText = (text && text.trim().length > 0 ? text : accumulatedText).trim();
          // Update the rolling summary with this turn's content so the
          // next request always has a fresh recap available.
          if (lastUserMessage && sessionId) {
            void updateRollingSummary(
              sessionId,
              lastUserMessage,
              finalText
            ).catch((err) => {
              syslog("warn", "memory", `Rolling summary update failed: ${err}`);
            });
          }
        } catch (err) {
          syslog(
            "warn",
            "agent",
            `streamText onEnd post-processing failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      onError: ({ error }) => {
        syslog("error", "agent", formatErrorDetail(error));
        safeEndChatTracking();
        void mcp?.close();
      },
      onAbort: () => {
        safeEndChatTracking();
        void mcp?.close();
      },
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: rawMessages,
        generateMessageId: () => `pmsg_${Date.now()}_${generateId()}`,
        // Attach per-step token usage and resolved reasoning effort to the
        // assistant message metadata so the client can render usage stats
        // and the next request can carry forward the reasoning tier.
        messageMetadata: ({ part }) => {
          if (part.type === "finish-step") {
            return { usage: part.usage, reasoningEffort: resolvedEffort };
          }
          return undefined;
        },
        // No shared state: the timeout classification is derived from the
        // error itself, because this mapper can run before streamText's
        // onError callback fires.
        onError: (error) => {
          void clearActiveSessionStream(sessionId, activeStreamId);
          return formatTimeoutForClient(error) ?? formatErrorDetail(error);
        },
        // Server-authoritative save (resumable-stream contract): the
        // client's settle-save remains for the live client, but a client
        // that died mid-stream (refresh, tab close, navigation) leaves
        // the finished turn in the database anyway.
        onEnd: async ({ messages: finalMessages }) => {
          try {
            const currentSession = await getProjectSession(sessionId);
            if (currentSession) {
              // Atomically release our stream only if it still matches.
              // If another request claimed a new stream in the meantime,
              // releaseProjectSessionStream affects 0 rows — we must NOT
              // clobber the new stream ID.
              releaseProjectSessionStream(sessionId, activeStreamId);
              // Persist final messages without touching activeStreamId
              // (saveProjectSession preserves the existing value when
              // activeStreamId is undefined).
              await saveProjectSession({
                ...currentSession,
                activeStreamId: undefined,
                messages: finalMessages,
                updatedAt: Date.now(),
              });
            }
          } catch (err) {
            syslog(
              "warn",
              "agent",
              `Failed to save project session on end: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        },
      }),
      headers: {
        "x-reasoning-effort": resolvedEffort,
        // Report the exact budget the guard enforces so the client's next
        // pre-send compaction targets the same number.
        "x-context-budget": String(budgetTokens),
        "x-context-dropped": String(droppedCount),
        // Report the effective context window so the client's display
        // matches what the server actually budgets against.
        "x-context-window": String(rawBudgetResult.effectiveWindow),
      },
      // Publish a resumable copy of the SSE stream: the registry holds
      // its branch open, so the generation survives the HTTP response
      // closing (page refresh, chat switch, tab hide) and a reconnect
      // via GET /api/projects/chat/[sessionId]/stream re-attaches to it.
      consumeSseStream: ({ stream }) => {
        publishStream(activeStreamId, sessionId, stream);
      },
    });
  } catch (err) {
    safeEndChatTracking();
    void mcp?.close();
    await clearActiveSessionStream(sessionId, activeStreamId);
    throw err;
  }
}
