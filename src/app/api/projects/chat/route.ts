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
import { formatErrorDetail } from "@/lib/ai/errors";
import { chatActiveTracker } from "@/lib/queue/tracker";
import { pruneMessagesToTokenBudget } from "@/lib/ai/context-budget";
import { getProject, createProjectHarnessTools } from "@/lib/project-service";
import { chatTools } from "@/lib/ai/tools";
import { collectMcpTools, type McpToolCollection } from "@/lib/ai/mcp/manager";
import {
  getReasoningProviderOptions,
  createThinkTagStreamTransformer,
} from "@/lib/ai/reasoning";
import { syslog } from "@/lib/observability/log-store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: {
    projectId?: string;
    messages?: UIMessage[];
    model?: string;
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

  const projectId = body?.projectId;
  if (!projectId || typeof projectId !== "string") {
    return new Response("projectId is required.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const project = await getProject(projectId);
  if (!project) {
    return new Response("Project not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!project.trusted) {
    return new Response(
      "Project directory is not trusted/approved. Please approve trusted directory access in the Project settings before running commands or agent orchestration.",
      {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }
    );
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const model = typeof body?.model === "string" ? body.model : undefined;
  const provider = body?.provider;

  const { messages: budgetedMessages, droppedCount } =
    pruneMessagesToTokenBudget(messages);
  if (droppedCount > 0) {
    console.info(
      `[project/chat] Pruned ${droppedCount} older messages for project ${project.name}`
    );
  }

  const providerOverrides = sanitizeProviderOverrides(provider);

  if (model && model !== defaultModelId && !providerOverrides?.baseUrl) {
    const available = await listModels();
    if (available.length > 0 && !available.some((m) => m.id === model)) {
      return new Response(`Model "${model}" is not available on this server.`, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  // Connect the enabled MCP servers and collect their tools
  let mcp: McpToolCollection | undefined;
  try {
    mcp = await collectMcpTools();
  } catch (err) {
    console.warn("[projects/chat] MCP tool collection failed:", err);
  }

  // Create project-scoped harness tools
  const projectTools = createProjectHarnessTools(project.directoryPath);
  const baseTools = {
    ...chatTools,
    ...projectTools,
  };

  const combinedTools = mcp
    ? {
        ...baseTools,
        ...Object.fromEntries(
          Object.entries(mcp.tools).filter(([name]) => !(name in baseTools))
        ),
      }
    : baseTools;

  const projectSystemPrompt = `You are Yggdrasil Project Harness Agent — a full-stack, autonomous coding agent orchestrating tasks inside the authorized project workspace: "${project.name}" (${project.directoryPath}).

You have direct access to tools for interacting with this project workspace:
- 'projectBash': Run shell commands (builds, tests, linters, git, dependency management) with the working directory fixed to '${project.directoryPath}'.
- 'projectReadFile': Read files line-by-line within the project.
- 'projectWriteFile': Create or modify project source files, configurations, and scripts.
- 'projectListFiles': List files and folders inside the project.
- 'manage_tasks': Plan and track multi-step execution checklists.
- 'web_search' & 'fetch_page': Search external documentation, libraries, and best practices.
- 'create_artifact': Render standalone UI mockups, interactive HTML/React deliverables, or documentation.

${project.customInstructions ? `Project Specific Instructions:\n${project.customInstructions}\n` : ""}${mcp?.instructions ? `\nMCP Integrations Instructions:\n${mcp.instructions}\n` : ""}
Guiding Principles:
1. Act methodically as a full-stack software engineer. Formulate plans, inspect the codebase, write tests/code, and verify changes with bash tools.
2. Only access files and execute commands within the authorized project directory scope.
3. Be concise and proactive in tool calling. Run the necessary commands and inspect results before asking questions.`;

  chatActiveTracker.startChat();
  let hasEndedChatTracking = false;
  const safeEndChatTracking = () => {
    if (!hasEndedChatTracking) {
      hasEndedChatTracking = true;
      chatActiveTracker.endChat();
    }
  };

  try {
    const result = streamText({
      model: model
        ? llm.chatModel(model, providerOverrides)
        : providerOverrides
          ? llm.chatModel(defaultModelId, providerOverrides)
          : defaultModel,
      system: projectSystemPrompt,
      messages: await convertToModelMessages(budgetedMessages),
      tools: combinedTools,
      providerOptions: getReasoningProviderOptions(model || defaultModelId, "xhigh"),
      abortSignal: req.signal,
      // Long-running harness orchestration up to 30 steps
      stopWhen: stepCountIs(30),
      experimental_transform: smoothStream({ chunking: "word", delayInMs: 10 }),
      onStepFinish: ({ toolCalls, toolResults, usage }) => {
        if (toolCalls && toolCalls.length > 0) {
          const names = toolCalls.map((t) => t.toolName).join(", ");
          syslog(
            "info",
            "harness",
            `Project harness step in ${project.name}: [${names}], tokens: ${usage?.totalTokens ?? 0}`
          );
        }
      },
      onEnd: async () => {
        safeEndChatTracking();
      },
      onError: () => {
        safeEndChatTracking();
      },
    });

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        onError: (err) => {
          safeEndChatTracking();
          return formatErrorDetail(err);
        },
      }),
    });
  } catch (error) {
    safeEndChatTracking();
    const message = formatErrorDetail(error);
    return new Response(message, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
