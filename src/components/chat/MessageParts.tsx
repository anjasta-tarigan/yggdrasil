"use client";

import { getToolName, isFileUIPart, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import {
  ARTIFACT_TOOLS,
  buildArtifactFromToolOutput,
  type ChatArtifact,
} from "@/lib/artifacts";
import { normalizeLatexDelimiters } from "@/lib/latex";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { ArtifactChip } from "./ArtifactChip";
import {
  extractSearchResults,
  ResearchTrail,
  researchToolInfo,
  safeHostname,
} from "./ResearchTrail";
import { QuestionTrail } from "./QuestionTrail";
import { SubagentInvocation } from "./SubagentInvocation";
import { TaskList } from "./TaskList";
import { ToolCallsTrail } from "./ToolCallsTrail";
import { ToolInvocation } from "./ToolInvocation";
import type { ReactNode } from "react";

/**
 * Whether one tool part belongs to the ChainOfThought research trail.
 * Matches builtins exactly and MCP-slugged duplicates
 * ("parallel-search__web_search") by their suffix.
 */
export function isResearchTool(name: string): boolean {
  return researchToolInfo(name) !== undefined;
}

/**
 * Tools whose invocations are rendered as a Task checklist. Includes the
 * legacy name (manage_tasks) so historical conversations keep rendering.
 */
export const TASK_TOOLS = new Set(["task_list_manager", "manage_tasks"]);

type MessagePartsProps = {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  onApproveTool?: (approvalId: string) => void;
  onDenyTool?: (approvalId: string, reason?: string) => void;
};

/**
 * Renders one message's parts:
 * - reasoning parts consolidated into a single collapsible <Reasoning> block
 *   that auto-opens while the last message is still streaming reasoning;
 * - web_search / web_fetch invocations synthesized into one ChainOfThought
 *   research trail;
 * - the latest task_list_manager invocation rendered as a Task checklist;
 * - pending ask_user_question parts rendered by the ChatArea popup,
 *   answered ones summarized in the unified Questions CoT trail;
 * - any other tool invocations rendered as collapsible Tool cards;
 * - text parts with LaTeX delimiter normalization + Streamdown rendering.
 */
export function MessageParts({
  message,
  isLastMessage,
  isStreaming,
  onOpenArtifact,
  onApproveTool,
  onDenyTool,
}: MessagePartsProps) {
  const reasoningParts = message.parts.filter(
    (part) => part.type === "reasoning"
  );
  const reasoningText = reasoningParts.map((part) => part.text).join("\n\n");
  const hasReasoning = reasoningParts.length > 0;

  // Reasoning is "streaming" only while the last message's most recent part
  // is still a reasoning part and the chat is actively streaming.
  const lastPart = message.parts.at(-1);
  const isReasoningStreaming =
    isLastMessage && isStreaming && lastPart?.type === "reasoning";

  const toolParts = message.parts.filter(isToolUIPart);
  const researchParts = toolParts.filter((part) =>
    isResearchTool(getToolName(part))
  );
  const taskParts = toolParts.filter((part) =>
    TASK_TOOLS.has(getToolName(part))
  );
  // Each task-list call replaces the list, so only the latest matters.
  const latestTaskPart = taskParts.at(-1);
  // QnA parts: pending ones are owned by the ChatArea popup; answered
  // ones render in the unified Questions CoT trail below.
  const questionParts = toolParts.filter(
    (part) => getToolName(part) === "ask_user_question"
  );

  // Generic tool parts: everything not already handled by ResearchTrail, TaskList,
  // QuestionTrail, ArtifactChip, SubagentInvocation, or the notify_user
  // receipt card (NotifyReceipt via ToolInvocation in the map loop).
  const genericParts = toolParts.filter((part) => {
    const name = getToolName(part);
    if (isResearchTool(name)) return false;
    if (TASK_TOOLS.has(name)) return false;
    if (ARTIFACT_TOOLS.has(name)) return false;
    if (name === "ask_user_question") return false;
    if (name === "notify_user") return false;
    if (name.startsWith("delegate_") && !name.startsWith("delegate__"))
      return false;
    return true;
  });

  // Split generic parts into built-in (static) and MCP (dynamic).
  const builtinParts = genericParts.filter(
    (part) => part.type !== "dynamic-tool"
  );
  const mcpParts = genericParts.filter((part) => part.type === "dynamic-tool");

  // Set of all generic part ids for skipping in the map loop.
  const genericPartIds = new Set(genericParts.map((p) => p.toolCallId));

  // artifact_publish chips (output-available) and error chips
  // (output-error); these parts never fall through to Tool cards.
  const artifactChips: ReactNode[] = [];
  if (message.role === "assistant") {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (!ARTIFACT_TOOLS.has(getToolName(part))) continue;
      if (part.state === "output-available") {
        const built = buildArtifactFromToolOutput(part.toolCallId, part.output);
        if (built) {
          artifactChips.push(
            <ArtifactChip
              artifact={built}
              key={`chip-${part.toolCallId}`}
              onOpen={onOpenArtifact}
            />
          );
        }
      } else if (part.state === "output-error") {
        artifactChips.push(
          <ArtifactChip
            errorText={part.errorText}
            key={`chip-${part.toolCallId}`}
            onOpen={onOpenArtifact}
          />
        );
      }
    }
  }

  // Extract sources from source-document parts or web_search tool results
  const sourcesList: Array<{ title: string; url: string; snippet?: string }> = [];
  for (const part of message.parts) {
    if (part.type === "source-document" && "source" in part && part.source) {
      const src = part.source as { title?: string; url?: string; description?: string };
      if (src.url) {
        sourcesList.push({ title: src.title ?? safeHostname(src.url), url: src.url, snippet: src.description });
      }
    }
  }
  for (const part of researchParts) {
    if (part.state === "output-available" && part.output) {
      // Both builtin (`results`) and Parallel-style MCP (`excerpts`)
      // search outputs feed the references list.
      const found = extractSearchResults(part.output as Parameters<
        typeof extractSearchResults
      >[0]);
      if (found) {
        for (const r of found) {
          if (!sourcesList.some((s) => s.url === r.url)) {
            sourcesList.push(r);
          }
        }
      }
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 1. Reasoning */}
      {hasReasoning && (
        <Reasoning className="w-full" isStreaming={isReasoningStreaming}>
          <ReasoningTrigger />
          <ReasoningContent>{reasoningText}</ReasoningContent>
        </Reasoning>
      )}

      {/* 2. CoT trails (ResearchTrail, QuestionTrail, TaskList) */}
      {researchParts.length > 0 && <ResearchTrail parts={researchParts} />}
      {questionParts.length > 0 && (
        <QuestionTrail isLastMessage={isLastMessage} parts={questionParts} />
      )}
      {latestTaskPart && <TaskList part={latestTaskPart} isStreaming={isLastMessage && isStreaming} />}

      {/* 3. ToolCallsTrail (Built-in and MCP) */}
      {builtinParts.length > 0 && (
        <ToolCallsTrail label="Built-in Tools" parts={builtinParts} />
      )}
      {mcpParts.length > 0 && (
        <ToolCallsTrail label="MCP Tools" parts={mcpParts} />
      )}

      {/* 4. Sources (references) */}
      {sourcesList.length > 0 && (
        <Sources className="" defaultOpen={false}>
          <SourcesTrigger count={sourcesList.length} />
          <SourcesContent>
            {sourcesList.map((src, i) => (
              <Source href={src.url} key={`source-${i}`} title={src.title} />
            ))}
          </SourcesContent>
        </Sources>
      )}

      {/* 5. ArtifactChips */}
      {artifactChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">{artifactChips}</div>
      )}

      {/* 6. Response text and remaining tool invocations (map loop) */}
      {message.parts.map((part, i) => {
        if (isToolUIPart(part)) {
          const name = getToolName(part);
          // Already rendered above as CoT steps / Task checklist / chips, or in ToolCallsTrail.
          if (
            isResearchTool(name) ||
            TASK_TOOLS.has(name) ||
            ARTIFACT_TOOLS.has(name) ||
            genericPartIds.has(part.toolCallId)
          ) {
            return null;
          }
          // Interactive questionnaire tool: rendered exclusively by the
          // QuestionTrail above (answered) or the ChatArea popup (pending).
          if (name === "ask_user_question") return null;
          // Subagent delegation tools get the dedicated renderer ("delegate_<slug>").
          // MCP server tools slugged "delegate" produce "delegate__<tool>" with two
          // underscores and fall through to generic Tool cards.
          if (name.startsWith("delegate_") && !name.startsWith("delegate__")) {
            return (
              <SubagentInvocation key={`${message.id}-${i}`} part={part} />
            );
          }
          return (
            <ToolInvocation
              key={`${message.id}-${i}`}
              onApproveTool={onApproveTool}
              onDenyTool={onDenyTool}
              part={part}
            />
          );
        }
        switch (part.type) {
          case "text":
            return (
              <MessageResponse key={`${message.id}-${i}`}>
                {normalizeLatexDelimiters(part.text)}
              </MessageResponse>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}