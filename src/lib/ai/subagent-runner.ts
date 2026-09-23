import {
  Output,
  ToolLoopAgent,
  generateId,
  isStepCount,
  readUIMessageStream,
  toUIMessageStream,
  tool,
  type ToolSet,
} from "ai";
import { z } from "zod";
import {
  chatModelForEntry,
  getDefaultModelEntry,
} from "@/lib/ai/provider";
import {
  getProviderById,
  resolveApiKey,
} from "@/lib/ai/provider-config/store";
import { getWebSession } from "@/lib/ai/web-provider/session-store";
import { chatTools } from "@/lib/ai/tools";
import { SubagentResultSchema, type SubagentResult } from "@/lib/ai/tools/subagent-result";
import { createSandboxTools } from "@/lib/sandbox/host-sandbox";
import { filterToolsForSubagent } from "@/lib/ai/tool-toggles";
import { syslog } from "@/lib/observability/log-store";
import {
  SUBAGENT_TOOL_REGISTRY,
  listEnabledSubagents,
  slugifySubagentName,
  toolNamesForKeys,
  type SubagentConfig,
} from "./subagents-service";
import { DELEGATE_TOOL_PREFIX } from "./tool-names";

/**
 * Subagent runner — bridges stored configs to live AI SDK v7 agents.
 *
 * Implements the exact pattern from the AI SDK v7 subagents guide:
 *  1. Build a ToolLoopAgent per config (own model, instructions, tools)
 *  2. Expose a delegation tool whose execute STREAMS the subagent's work
 *     to the UI via preliminary tool results (async generator + yields)
 *  3. readUIMessageStream accumulates each chunk into a complete UIMessage
 *  4. toModelOutput shows the USER everything the subagent did while the
 *     MAIN MODEL sees only the final text summary — the context-offload
 *  5. abortSignal propagates so cancelling the chat cancels the subagent
 *
 * Cancellation note (docs): aborting makes the subagent throw AbortError,
 * which fails the tool call and stops the main loop — correct behavior.
 */

/** Prefix for every generated delegation tool name (single source). */
export { DELEGATE_TOOL_PREFIX };

/** Build a subagent's toolset from its granted capability keys. */
export function buildSubagentTools(config: SubagentConfig): ToolSet {
  const toolNames = new Set<string>();
  for (const key of config.tools) {
    const entry = SUBAGENT_TOOL_REGISTRY.find((t) => t.key === key);
    if (!entry) continue;
    for (const name of entry.toolNames) toolNames.add(name);
  }

  // The sandbox toolset is constructed per call (fresh handles, matching
  // chat/route.ts's per-request construction) instead of shared from a
  // module-level singleton.
  const sandboxTools = createSandboxTools() as Record<string, unknown>;
  const chatToolsRecord = chatTools as unknown as Record<string, unknown>;

  const result: ToolSet = {};
  for (const name of toolNames) {
    const t =
      name in sandboxTools ? sandboxTools[name] : chatToolsRecord[name];
    if (t) result[name] = t as ToolSet[string];
  }
  // A tool the user disabled globally is a disabled capability, not a
  // per-agent suggestion — apply the same toggle policy to subagent
  // grants as to the main chat toolset.
  return filterToolsForSubagent(result);
}

/**
 * Resolve the language model for a subagent config.
 *
 * A stored model ref may be a qualified "providerId::modelId" (the
 * Subagents UI invites this format) — split on the qualifier and resolve
 * each half against the registry, exactly like the main chat route. A
 * bare model id belongs to the server provider. Model-list membership
 * is looser here than in the chat route (a subagent may run any model
 * id the gateway serves — the registry entry only supplies the
 * baseUrl/key/kind); a MISSING PROVIDER degrades to the default model
 * entry rather than throwing, matching the pre-registry env-fallback.
 */
export async function resolveModel(config: SubagentConfig) {
  const rawRef = config.model?.trim();
  const separator = rawRef?.indexOf("::");
  const hasQualifier =
    separator !== undefined && separator !== -1 && !!rawRef;
  const providerId = hasQualifier ? rawRef!.slice(0, separator) : "server";
  const modelId = hasQualifier
    ? rawRef!.slice(separator! + 2) || undefined
    : rawRef || undefined;

  if (modelId) {
    const entry = await getProviderById(providerId);
    if (entry) {
      if (entry.kind === "web-session") {
        const session = await getWebSession(entry.id);
        if (!session || session.status !== "verified") {
          throw new Error(
            "DeepSeek Web session expired or was rejected. Re-import the session token to continue."
          );
        }
        return chatModelForEntry(modelId, entry, undefined, session);
      }
      return chatModelForEntry(modelId, entry, await resolveApiKey(entry));
    }
    // Unknown provider in the ref: degrade to the default model entry
    // instead of throwing mid-chat (the subagent still runs, on the
    // server's configured model).
    syslog(
      "warn",
      "subagents",
      `Subagent "${config.name}" model ref names unknown provider "${providerId}" — falling back to the default model`
    );
  }

  const def = await getDefaultModelEntry();
  if (!def) {
    throw new Error(
      "No default model configured — add a provider and model in Settings → Providers."
    );
  }
  if (def.provider.kind === "web-session") {
    const session = await getWebSession(def.provider.id);
    if (!session || session.status !== "verified") {
      throw new Error(
        "DeepSeek Web session expired or was rejected. Re-import the session token to continue."
      );
    }
    return chatModelForEntry(def.model.modelId, def.provider, undefined, session);
  }
  return chatModelForEntry(
    def.model.modelId,
    def.provider,
    await resolveApiKey(def.provider)
  );
}

/** Build a ToolLoopAgent from a stored config. */
export async function buildSubagent(
  config: SubagentConfig,
  runtimeContext?: Record<string, unknown>,
  callOptions?: Record<string, unknown>,
): Promise<ToolLoopAgent> {
  const tools = buildSubagentTools(config);
  // Provide execution aliases so code models trained on "shell" or "exec" succeed
  if (tools.bash) {
    tools.shell = tools.bash;
    tools.exec = tools.bash;
  }

  return new ToolLoopAgent({
    model: await resolveModel(config),
    instructions: config.instructions,
    tools,
    stopWhen: isStepCount(config.maxSteps),
    ...(runtimeContext ? { runtimeContext } : {}),
    callOptionsSchema: z.object({
      _taskDomain: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "auto"]).optional(),
    }),
    prepareCall: ({ options, ...settings }) => ({
      ...settings,
      options: {
        ...(options ?? {}),
        _taskDomain: config.name,
        ...(callOptions ?? {}),
      },
    }),
    output: Output.object({ schema: SubagentResultSchema }),
  });
}

/**
 * Build the delegation tool for one subagent config.
 *
 * The tool name is `delegate_<slug>`; the description teaches the main
 * model WHEN to delegate. Streaming progress reaches the UI as
 * preliminary tool results; toModelOutput compresses everything the
 * subagent did into its final text for the main model.
 */
export function buildSubagentTool(config: SubagentConfig) {
  // Single-source slug helper (no duplicated regex here).
  const slug = slugifySubagentName(config.name);
  const toolName = `${DELEGATE_TOOL_PREFIX}${slug}`;
  const toolDesc = config.description?.trim() || config.name;
  // Real tool names, not registry keys — "bash, readFile, writeFile" not
  // "sandbox, tasks" (the keys are capability groups, not tools).
  const capabilitySummary = toolNamesForKeys(config.tools).join(", ");

  // Delegation guidance is CONFIG-driven (single source of truth — the
  // stored row owns it; the runner never sniffs names, so a renamed or
  // user-created subagent carries exactly the guidance its config holds).
  const guidance =
    config.delegationGuidance?.trim() ||
    "Use for work that matches its specialty, especially tasks needing lots of exploration or iterations that would bloat this conversation.";

  // OpenAI-compatible gateways commonly cap function descriptions at 1024
  // chars; trim from the tail if a long config name/description crosses it.
  const MAX_DESCRIPTION_CHARS = 1024;
  let description = `Delegate a task to the "${config.name}" subagent (${toolDesc}). It runs autonomously with these tools: ${capabilitySummary}. Returns a focused summary. ${guidance}`;
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = `${description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
  }

  // Captured structured output from the subagent's `result.output` promise
  // (populated by execute() below via Output.object). Read by toModelOutput()
  // so the main model receives a schema-validated summary instead of raw text
  // that must be suffix-checked for completion.
  let capturedStructuredOutput: SubagentResult | undefined;

  /**
   * Format a parsed SubagentResult into the compact summary the main model
   * sees — identical formatting whether the source is a captured
   * result.output or a data-* part.
   */
  function formatStructuredResult(result: SubagentResult): string {
    return (
      `[Subagent ${config.name}]: ${result.summary}\n\n` +
      `Key findings:\n${result.keyFindings.map((f) => `- ${f}`).join("\n")}\n\n` +
      `Next steps:\n${result.nextSteps.map((s) => `- ${s}`).join("\n")}`
    );
  }

  return {
    name: toolName,
    tool: tool({
      description,
      inputSchema: z.object({
        task: z
          .string()
          .min(1)
          .max(8_000)
          .describe("The complete, self-contained task for the subagent"),
      }),
      execute: async function* ({ task }, { abortSignal }) {
        syslog(
          "info",
          "subagents",
          `Delegating to "${config.name}": ${task.slice(0, 120)}${task.length > 120 ? "…" : ""}`
        );
        const subagent = await buildSubagent(config, {
          // Subagent-scoped runtime context: a fresh requestId per delegation
          // so subagent generations are traceable independently of the parent
          // chat, linked back via chatId (the config name — SubagentConfig
          // exposes no persisted slug field).
          requestId: generateId(),
          chatId: config.name,
          modelId: config.model ?? "default",
          featureFlags: { delegated: true },
        });
        const result = await subagent.stream({
          prompt: task,
          abortSignal,
        });

        let yieldedAny = false;
        // Each iteration yields a complete, accumulated UIMessage (docs
        // pattern); the UI replaces its display with each new message.
        // terminateOnError: stream errors are rethrown here instead of
        // being swallowed, so the tool part reaches output-error and the
        // MAIN MODEL sees the failure instead of a fake "Task completed."
        for await (const message of readUIMessageStream({
          stream: toUIMessageStream({
            stream: result.stream,
            onError: (err) => {
              const msg = err instanceof Error ? err.message : String(err);
              syslog(
                "error",
                "subagents",
                `Subagent "${config.name}" stream error: ${msg}`
              );
              return msg;
            },
          }),
          terminateOnError: true,
        })) {
          yieldedAny = true;
          yield message;
        }

        if (!yieldedAny) {
          // The stream produced nothing (e.g. model rejected before the
          // first chunk) — surface it instead of silently "completing".
          syslog(
            "warn",
            "subagents",
            `Subagent "${config.name}" produced no output for task: ${task.slice(0, 120)}`
          );
        }

        // After the UI message stream drains, capture the structured output
        // that Output.object produced. result.output resolves to the parsed
        // SubagentResult once the final step finishes (the finish-step chunk
        // that closes the stream carries that signal). If the model's JSON
        // was unparseable or the stream aborted, leave capturedStructuredOutput
        // undefined so toModelOutput falls through to the text-based path.
        try {
          capturedStructuredOutput = (await result.output) as SubagentResult;
        } catch (err) {
          syslog("debug", "subagent-runner", `Error: ${err instanceof Error ? err.message : String(err)}`);
          capturedStructuredOutput = undefined;
        }
      },
      toModelOutput: ({ output: message }) => {
        // 1. Structured output captured from result.output (Output.object path).
        //    The SDK parses + schema-validates the subagent's JSON response, so
        //    we can trust this as the authoritative summary.
        if (capturedStructuredOutput) {
          try {
            const parsed = SubagentResultSchema.parse(capturedStructuredOutput);
            return { type: "text", value: formatStructuredResult(parsed) };
          } catch (err) {
            syslog("debug", "subagent-runner", `Error: ${err instanceof Error ? err.message : String(err)}`);
            // Schema mismatch despite Output.object — fall through.
          }
        }

        // 2. Fall back to data-* parts (some providers/streams emit these
        //    instead of, or in addition to, a captured result.output).
        const dataPart = message?.parts.findLast(
          (p) => typeof p.type === "string" && p.type.startsWith("data-")
        ) as { data?: unknown } | undefined;

        if (dataPart?.data) {
          try {
            const parsed = SubagentResultSchema.parse(dataPart.data);
            return { type: "text", value: formatStructuredResult(parsed) };
          } catch (err) {
            syslog("debug", "subagent-runner", `Error: ${err instanceof Error ? err.message : String(err)}`);
            // Schema mismatch — fall through to text extraction.
          }
        }

        // 3. Backward-compatible text extraction (pre-Output.object behavior).
        //    Show the user everything; give the main model only the final
        //    text summary (docs pattern).
        const lastTextPart = message?.parts.findLast(
          (p) => p.type === "text"
        ) as { text?: string } | undefined;
        const text = lastTextPart?.text?.trim();

        // A finished subagent ends its summary with "SUMMARY COMPLETE."
        // (the persona instructs it to). Without that signal, a run cut at
        // its step limit mid-investigation would pass trailing narration
        // ("fetching the migration guide to verify…") to the main model as
        // if it were the final cited findings — silent partial output.
        const isComplete =
          text !== undefined && text.endsWith("SUMMARY COMPLETE.");
        const flagged = isComplete
          ? text
          : `[Subagent hit its step limit before finishing — partial findings, treat as incomplete:]\n${text ?? ""}`;

        return {
          type: "text" as const,
          // Empty/absent summary is reported honestly, never faked success.
          value: text && text.length > 0 ? flagged : "Task failed or produced no text summary.",
        };
      },
    }),
  };
}

/**
 * Build the delegation tools for all enabled subagents. Called once per
 * chat request; empty array when none are enabled (zero overhead).
 *
 * Duplicate tool names (two configs whose names slugify identically, or a
 * name that slugifies to empty — e.g. "###") are dropped after the first
 * so Object.assign in the chat route can never silently last-writer-wins
 * two subagents onto one delegation tool.
 */
export async function buildSubagentToolsForChat(): Promise<
  Array<{ name: string; tool: ReturnType<typeof buildSubagentTool>["tool"] }>
> {
  const enabled = listEnabledSubagents();
  const seenNames = new Set<string>();
  const result: Array<{
    name: string;
    tool: ReturnType<typeof buildSubagentTool>["tool"];
  }> = [];
  for (const config of enabled) {
    const built = buildSubagentTool(config);
    if (!built.name || built.name === DELEGATE_TOOL_PREFIX) {
      // Empty slug → unusable tool name; skip rather than emit "delegate_".
      syslog(
        "warn",
        "subagents",
        `Skipping enabled subagent "${config.name}": name slugifies to an empty tool-name suffix`
      );
      continue;
    }
    if (seenNames.has(built.name)) {
      syslog(
        "warn",
        "subagents",
        `Skipping enabled subagent "${config.name}": delegation tool "${built.name}" already built (duplicate slug)`
      );
      continue;
    }
    seenNames.add(built.name);
    result.push({ name: built.name, tool: built.tool });
  }
  return result;
}
