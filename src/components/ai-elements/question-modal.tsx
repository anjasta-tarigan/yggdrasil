"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { QuestionCard, type QuestionCardAnswers } from "./question-card";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { useRef, useState } from "react";

interface QuestionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  part: ToolUIPart | DynamicToolUIPart;
  onAnswer: (answers: QuestionCardAnswers) => void;
}

/** Marker string used when the user dismisses instead of answering. */
export const QUESTION_DECLINED_ANSWER =
  "User declined to answer the question.";

/**
 * Popup host for a pending ask_user_question part. Parents must key
 * this by toolCallId: the internal `answered` flag is per tool call,
 * and remounting on a new part resets it without effect cascades.
 */
export function QuestionModal({
  open,
  onOpenChange,
  part,
  onAnswer,
}: QuestionModalProps) {
  const [answered, setAnswered] = useState(false);
  // Synchronous guard: Radix fires onPointerDownOutside AND
  // onInteractOutside for one overlay interaction, and React state
  // updates don't land between the two calls in the same tick. The ref
  // makes the answer path idempotent within that tick.
  const resolvedRef = useRef(false);

  const handleAnswer = (answers: QuestionCardAnswers) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    setAnswered(true);
    onAnswer(answers);
    // Close so the resolved tool result can resume the chat loop.
    onOpenChange(false);
  };

  // Dismissing the popup (Escape key, overlay click, or the X button)
  // declines every unanswered question — resolving the tool call so the
  // model knows the user skipped the form rather than silently leaving
  // the conversation stalled mid-turn.
  const declineAll = () => {
    const input = (part.input ?? {}) as {
      questions?: Array<{ question: string }>;
    };
    const declines: QuestionCardAnswers = {};
    for (const q of input.questions ?? []) {
      declines[q.question] = QUESTION_DECLINED_ANSWER;
    }
    handleAnswer(declines);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !answered) {
      declineAll();
      return;
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="gap-0 p-4 sm:max-w-md"
        showCloseButton={true}
        // The X button routes through Radix Close, which calls
        // onOpenChange(false); the intercept above turns that into a
        // decline instead of a silent close.
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          handleOpenChange(false);
        }}
        onPointerDownOutside={(e) => {
          e.preventDefault();
          handleOpenChange(false);
        }}
      >
        <DialogTitle className="sr-only">Assistant question</DialogTitle>
        <QuestionCard part={part} onAnswer={handleAnswer} />
      </DialogContent>
    </Dialog>
  );
}
