"use client";

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { MessageCircleQuestionIcon } from "lucide-react";
import { isQuestionAnswered } from "./chat-utils";

/** Decline marker the QuestionModal writes when the popup is dismissed. */
const DECLINED_MARKER = "User declined to answer the question.";

type QuestionTrailProps = {
  parts: Array<ToolUIPart | DynamicToolUIPart>;
  /**
   * Whether this message is the chat's live edge. The Questions trail
   * has no "running" state of its own — its parts are answered the
   * moment they render — so the live message is the only place a
   * fresh answer exists: mount open there and fold a second later
   * (the armed grace timer runs from mount). Historical messages
   * mount already minimized.
   */
  isLastMessage?: boolean;
};

/**
 * Unified ChainOfThought rendering for answered ask_user_question tool
 * calls. Pending parts render nothing — the QuestionModal popup in
 * ChatArea owns those — so the chat view never shows a QnA card. Each
 * answered tool call becomes one "Asked the user" step whose content
 * lists every question with the user's (or declined) answer.
 */
export function QuestionTrail({ parts, isLastMessage = false }: QuestionTrailProps) {
  const answered = parts.filter(
    (part) =>
      getToolName(part) === "ask_user_question" && isQuestionAnswered(part)
  );

  if (answered.length === 0) return null;

  return (
    <ChainOfThought className="mb-4" defaultOpen={isLastMessage}>
      <ChainOfThoughtHeader>
        {`Questions — ${answered.length} step${answered.length === 1 ? "" : "s"}`}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {answered.map((part) => {
          const input = (part.input ?? {}) as {
            questions?: Array<{ question: string }>;
          };
          const output = (part.output ?? {}) as {
            answers?: Record<string, string | string[]>;
          };
          const answers = output.answers ?? {};

          return (
            <ChainOfThoughtStep
              icon={MessageCircleQuestionIcon}
              key={part.toolCallId}
              label="Asked the user"
              status="complete"
            >
              <ul className="space-y-1.5">
                {input.questions?.map((q) => {
                  const answer = answers[q.question];
                  const declined =
                    answer === DECLINED_MARKER ||
                    (Array.isArray(answer) &&
                      answer.length > 0 &&
                      answer.every((a) => a === DECLINED_MARKER));
                  const text = Array.isArray(answer)
                    ? answer.join(", ")
                    : answer;

                  return (
                    <li className="text-xs" key={q.question}>
                      <span className="text-muted-foreground">
                        {q.question}
                      </span>
                      <span className="mx-1.5 text-muted-foreground/60">
                        →
                      </span>
                      <span
                        className={
                          declined
                            ? "text-muted-foreground/70 italic"
                            : "font-medium text-foreground"
                        }
                      >
                        {declined
                          ? "Declined"
                          : text || <em>n/a</em>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </ChainOfThoughtStep>
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
