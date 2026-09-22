import { WorkflowAgent } from "@ai-sdk/workflow";
import { convertToModelMessages, isStepCount, type UIMessage, type ModelMessage } from "ai";
import { z } from "zod";
import { getWritable } from "workflow";
import { DurableLanguageModel, type DurableModelInit } from "@/lib/ai/durable-model";
import {
  HARNESS_MAX_STEPS,
  createHarnessPrepareStep,
  harnessStopReason,
  type HarnessStopReason,
} from "@/lib/ai/harness-policy";
import { bashToolNeedsApproval, fileOperationsNeedsApproval } from "@/lib/project-harness-approval";
import {
  projectBashStep,
  projectFileOpsStep,
  projectWebSearchStep,
  projectWebFetchStep,
  projectArtifactStep,
  projectTasksStep,
} from "./project-harness-steps";
import { buildDurableModel } from "@/lib/ai/durable-model-step";
import { finalizeHarnessRunStep } from "./project-harness-finalize";
import { getWorkflowMetadata } from "workflow";

/**
 * Resolves a provider's connection data (baseUrl + apiKey) from the registry
 * inside a step. The registry reads node:fs, which the workflow function cannot
 * do, so resolution happens here and the plain result is carried into the model.
 */
async function resolveModelStep(init: DurableModelInit): Promise<DurableModelInit> {
  "use step";
  return buildDurableModel(init);
}

// NOTE: the durable harness currently wires only the mutating local tools
// (`bash`, `file_operations`) as durable steps. `web_search`/`web_fetch`/
// `manage_tasks`/`create_artifact` pull `node:dns`/`db`/`log-store` into the
// workflow bundle, which the Workflow runtime forbids; they need their own step
// wrappers (a follow-up) before they can join the durable tool set.

export interface ProjectHarnessInput {
  projectId: string;
  sessionId: string;
  directoryPath: string;
  trusted: boolean;
  /**
   * The provider connection, already resolved to plain data by a `"use step"`
   * function in the route (the registry reads node:fs). The model rebuilds its
   * provider from this on the far side of the doStreamStep boundary.
   */
  modelInit: DurableModelInit;
  messages: UIMessage[];
  budgetTokens: number;
  /** The system prompt, built by the route (no Node.js access here). */
  systemPrompt: string;
}

/**
 * One durable Projects turn.
 *
 * The workflow function itself does no I/O and no domain work: it builds the
 * agent and streams. `WorkflowAgent` creates the durable steps internally — the
 * model call in its own `doStreamStep`, and each tool whose `execute` carries
 * `"use step"` — so a crash mid-turn re-runs only the incomplete step, not the
 * whole turn.
 *
 * `stopWhen` is mandatory: the agent applies no default step limit and would
 * otherwise run until the model stops calling tools.
 *
 * Tool configuration is NOT passed by closure (a step receives parameters, not the
 * workflow's live scope). Instead each durable tool reads `{ canonicalRoot, trusted }`
 * from the per-tool `toolsContext` entry, which the route supplies from
 * `ProjectHarnessInput`. The mutating tools set `maxRetries = 0` so a half-applied
 * change is reported rather than silently re-run (spec §3.6.4).
 */
export async function projectHarnessWorkflow(
  input: ProjectHarnessInput
): Promise<{
  finishReason: string;
  stopReason: HarnessStopReason;
  messages: ModelMessage[];
}> {
  "use workflow";

  // Resolve the provider's connection data (baseUrl + apiKey) from the registry
  // inside a step — the registry reads node:fs, which the workflow function
  // cannot do. The raw ref arrives as plain data; the step returns a full
  // DurableModelInit the model rebuilds its provider from.
  const modelInit = await resolveModelStep(input.modelInit);

  const tools = {
    bash: {
      description:
        "Run a bash or shell command inside the project workspace directory.",
      inputSchema: z.object({
        command: z.string().max(4000).optional(),
        cmd: z.string().max(4000).optional(),
      }),
      needsApproval: bashToolNeedsApproval,
      execute: projectBashStep,
      maxRetries: 0,
    } as never,
    file_operations: {
      description:
        "Filesystem operations scoped to the project workspace directory.",
      inputSchema: z.object({ action: z.string() }).passthrough(),
      needsApproval: fileOperationsNeedsApproval,
      execute: projectFileOpsStep,
      maxRetries: 0,
    } as never,
    web_search: {
      description:
        "Search the web for current, factual, or external information. Call this autonomously for recent events, versions, docs, or facts to verify.",
      inputSchema: z.object({
        query: z.string(),
        numResults: z.number().int().min(1).max(10).default(5),
        includeText: z.boolean().default(false),
      }),
      execute: projectWebSearchStep,
      maxRetries: 1,
    } as never,
    web_fetch: {
      description:
        "Fetch a web page and return its content as markdown (Firecrawl, then native HTTP fallback). Use after web_search to read a specific URL.",
      inputSchema: z
        .object({
          url: z.string(),
          maxCharacters: z.number().int().optional(),
        })
        .passthrough(),
      execute: projectWebFetchStep,
      maxRetries: 1,
    } as never,
    create_artifact: {
      description:
        "Save and display a standalone deliverable (code file, document, or multi-file project) in the side panel. Always use this instead of emitting full standalone code in a text reply.",
      inputSchema: z
        .object({
          title: z.string(),
          kind: z.enum(["code", "document", "project"]),
          language: z.string().optional(),
          content: z.string().optional(),
          files: z
            .array(
              z.object({
                path: z.string(),
                content: z.string(),
                language: z.string().optional(),
              })
            )
            .optional(),
        })
        .passthrough(),
      execute: projectArtifactStep,
      maxRetries: 0,
    } as never,
    manage_tasks: {
      description:
        "Create or update a visible task checklist for complex, multi-step requests.",
      inputSchema: z.object({
        title: z.string(),
        items: z
          .array(
            z.object({
              text: z.string(),
              status: z.enum(["pending", "in_progress", "completed"]),
            })
          )
          .min(1)
          .max(20),
      }),
      execute: projectTasksStep,
      maxRetries: 0,
    } as never,
  };

  const agent = new WorkflowAgent({
    model: new DurableLanguageModel(modelInit) as never,
    instructions: input.systemPrompt,
    tools: tools as never,
    toolsContext: {
      bash: {
        canonicalRoot: input.directoryPath,
        trusted: input.trusted,
        timeoutMs: 240_000,
        maxOutputChars: 40_000,
      },
      file_operations: {
        canonicalRoot: input.directoryPath,
        trusted: input.trusted,
        maxOutputChars: 40_000,
        maxOutputBytes: 5 * 1024 * 1024,
      },
    } as never,
    stopWhen: isStepCount(HARNESS_MAX_STEPS),
    prepareStep: createHarnessPrepareStep({
      contextBudgetTokens: input.budgetTokens,
    }) as never,
  });

  const result = await agent.stream({
    messages: await convertToModelMessages(input.messages),
    writable: getWritable(),
  });

  const stopReason = harnessStopReason({
    steps: (result.steps as unknown as unknown[]).length,
    finishReason: String(result.finishReason),
    contextWrapUp: false,
  });

  // Persist the turn and release the run slot. Runs as a durable step because it
  // touches the SQLite store (node:fs), which the workflow function cannot do.
  await finalizeHarnessRunStep({
    sessionId: input.sessionId,
    runId: getWorkflowMetadata().workflowRunId,
    messages: result.messages,
  });

  return {
    finishReason: String(result.finishReason),
    stopReason,
    messages: result.messages,
  };
}
