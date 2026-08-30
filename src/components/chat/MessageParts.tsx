"use client";

import { getToolName, isFileUIPart, isToolUIPart } from "ai";
import type { UIMessage } from "ai";
import {
  ARTIFACT_TOOL,
  buildArtifactFromToolOutput,
  type ChatArtifact,
} from "@/lib/artifacts";
import { normalizeLatexDelimiters } from "@/lib/latex";
import {
  Attachment,
  AttachmentPreview,
  Attachments,
} from "@/components/ai-elements/attachments";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  QuestionCard,
  type QuestionCardAnswers,
} from "@/components/ai-elements/question-card";
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
import { ResearchTrail, safeHostname } from "./ResearchTrail";
import { SubagentInvocation } from "./SubagentInvocation";
import { TaskList } from "./TaskList";
import { ToolInvocation } from "./ToolInvocation";
import type { ReactNode } from "react";

/** Tools rendered as ChainOfThought research steps instead of Tool cards. */
export const RESEARCH_TOOLS = new Set(["web_search", "fetch_page"]);

/** The tool whose invocations are rendered as a Task checklist. */
export const TASK_TOOL = "manage_tasks";

type MessagePartsProps = {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  onAnswerQuestion?: (toolCallId: string, answers: QuestionCardAnswers) => void;
  onApproveTool?: (approvalId: string) => void;
  onDenyTool?: (approvalId: string, reason?: string) => void;
};

/**
 * Renders one message's parts:
 * - reasoning parts consolidated into a single collapsible <Reasoning> block
 *   that auto-opens while the last message is still streaming reasoning;
 * - web_search / fetch_page invocations synthesized into one ChainOfThought
 *   research trail;
 * - the latest manage_tasks invocation rendered as a Task checklist;
 * - any other tool invocations rendered as collapsible Tool cards;
 * - text parts with LaTeX delimiter normalization + Streamdown rendering.
 */
export function MessageParts({
  message,
  isLastMessage,
  isStreaming,
  onOpenArtifact,
  onAnswerQuestion,
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
    RESEARCH_TOOLS.has(getToolName(part))
  );
  const taskParts = toolParts.filter(
    (part) => getToolName(part) === TASK_TOOL
  );
  // Each manage_tasks call replaces the list, so only the latest matters.
  const latestTaskPart = taskParts.at(-1);

  // create_artifact chips (output-available) and error chips
  // (output-error); these parts never fall through to Tool cards.
  const artifactChips: ReactNode[] = [];
  if (message.role === "assistant") {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (getToolName(part) !== ARTIFACT_TOOL) continue;
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

  const fileParts = message.parts.filter(isFileUIPart);

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
      const out = part.output as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
      if (Array.isArray(out.results)) {
        for (const r of out.results) {
          if (r.url && !sourcesList.some((s) => s.url === r.url)) {
            sourcesList.push({ title: r.title ?? safeHostname(r.url), url: r.url, snippet: r.snippet });
          }
        }
      }
    }
  }

  return (
    <>
      {sourcesList.length > 0 && (
        <Sources className="mb-3" defaultOpen={false}>
          <SourcesTrigger count={sourcesList.length} />
          <SourcesContent>
            {sourcesList.map((src, i) => (
              <Source href={src.url} key={`source-${i}`} title={src.title} />
            ))}
          </SourcesContent>
        </Sources>
      )}
      {fileParts.length > 0 && (
        <Attachments className="mb-2" variant="grid">
          {fileParts.map((file, i) => (
            <Attachment
              data={{ ...file, id: `file-${message.id}-${i}` }}
              key={`file-${message.id}-${i}`}
            >
              <AttachmentPreview />
            </Attachment>
          ))}
        </Attachments>
      )}
      {hasReasoning && (
        <Reasoning className="w-full" isStreaming={isReasoningStreaming}>
          <ReasoningTrigger />
          <ReasoningContent>{reasoningText}</ReasoningContent>
        </Reasoning>
      )}
      {researchParts.length > 0 && <ResearchTrail parts={researchParts} />}
      {latestTaskPart && <TaskList part={latestTaskPart} />}
      {artifactChips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">{artifactChips}</div>
      )}
      {message.parts.map((part, i) => {
        if (isToolUIPart(part)) {
          const name = getToolName(part);
          // Already rendered above as CoT steps / Task checklist / chips.
          if (
            RESEARCH_TOOLS.has(name) ||
            name === TASK_TOOL ||
            name === ARTIFACT_TOOL
          ) {
            return null;
          }
          // Interactive questionnaire tool: rendered as rich QuestionCard.
          if (name === "ask_user_question") {
            return (
              <QuestionCard
                key={`${message.id}-${i}`}
                onAnswer={(answers) => {
                  if (onAnswerQuestion) {
                    onAnswerQuestion(part.toolCallId, answers);
                  }
                }}
                part={part}
              />
            );
          }
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
    </>
  );
}
