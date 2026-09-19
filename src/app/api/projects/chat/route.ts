import { NextResponse } from "next/server";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type ToolSet,
  type UIMessage,
} from "ai";
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
} from "@/lib/ai/context-budget";
import { inferKnownModelCapabilities } from "@/lib/ai/model-heuristics";
import {
  getReasoningProviderOptions,
  type ReasoningEffortTier,
} from "@/lib/ai/reasoning";
import { evaluateToolApproval } from "@/lib/ai/tool-policy";
import { resolveApprovalSecret } from "@/lib/ai/approval-secret";

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

  const projectTools = createProjectHarnessTools({
    projectDirectory: project.directoryPath,
    canonicalRoot,
    trusted: project.trusted,
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
  const rawBudgetResult = calculateContextTokenBudget({
    contextWindow:
      resolvedModelEntry?.capabilities?.contextWindow ??
      inferredCaps?.contextWindow,
    requestedOutputTokens:
      resolvedModelEntry?.capabilities?.maxOutputTokens ?? 4096,
  });
  const budgetTokens = rawBudgetResult.budgetTokens;
  const { messages: budgetedMessages } = compactAndPruneMessages(
    processedMessages,
    budgetTokens
  );

  const reasoningEffort =
    typeof effort === "string" && ["low", "medium", "high", "xhigh"].includes(effort)
      ? (effort as ReasoningEffortTier)
      : "xhigh";
  const providerOptions = getReasoningProviderOptions(resolvedModelId, reasoningEffort);

  const systemPrompt = await synthesizeProjectSystemPrompt(project);
  const approvalSecret = await resolveApprovalSecret();

  const activeStreamId = generateId();

  // Atomically claim the stream via a conditional UPDATE
  // (active_stream_id IS NULL). If another concurrent request already
  // set a non-null activeStreamId, this affects 0 rows → 409 Conflict.
  // This eliminates the TOCTOU window between the read-check above and
  // the save — Spec §4.3: "At most 1 active LLM generation stream per
  // project_session."
  if (!claimProjectSessionStream(sessionId, activeStreamId)) {
    return NextResponse.json(
      { error: "Session stream is already in progress" },
      { status: 409 }
    );
  }

  try {
    // Persist incoming messages (does not touch activeStreamId — claim
    // already set it atomically). Must stay inside the try: if this throws
    // after the claim above, the catch below releases the stream. Leaving it
    // outside leaked the claim, permanently 409-ing every later request.
    await saveProjectSession({
      ...session,
      activeStreamId: undefined,
      messages: rawMessages,
      updatedAt: Date.now(),
    });

    const result = streamText({
      model: resolved,
      instructions: systemPrompt,
      messages: await convertToModelMessages(budgetedMessages, {
        ignoreIncompleteToolCalls: true,
        tools: combinedTools,
      }),
      tools: combinedTools,
      stopWhen: stepCountIs(30),
      providerOptions,
      toolApproval: async ({ toolCall }) => {
        return evaluateToolApproval(toolCall.toolName, toolCall.input);
      },
      experimental_toolApprovalSecret: approvalSecret,
      // Do NOT pass abortSignal: req.signal (resumable stream contract)
      onEnd: async () => {
        await mcp?.close();
      },
      onError: ({ error }) => {
        console.error("[projects/chat] streamText error:", error);
        void mcp?.close();
      },
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        originalMessages: rawMessages,
        generateMessageId: () => `pmsg_${Date.now()}_${generateId()}`,
        onError: (error) => {
          void clearActiveSessionStream(sessionId, activeStreamId);
          return formatErrorDetail(error);
        },
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
            console.warn("[projects/chat] Failed to save project session on end:", err);
          }
        },
      }),
      consumeSseStream: ({ stream }) => {
        publishStream(activeStreamId, sessionId, stream);
      },
    });
  } catch (err) {
    console.error("[projects/chat] Failed to start chat stream:", err);
    void mcp?.close();
    await clearActiveSessionStream(sessionId, activeStreamId);
    throw err;
  }
}
