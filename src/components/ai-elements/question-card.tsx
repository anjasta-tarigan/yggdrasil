"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircle2Icon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Code2Icon,
  MessageCircleQuestionIcon,
  SendIcon,
} from "lucide-react";
import type { ComponentProps, FormEvent } from "react";
import { useState } from "react";

export type QuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type QuestionItem = {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: QuestionOption[];
};

export type QuestionCardInput = {
  questions: QuestionItem[];
};

export type QuestionCardAnswers = Record<string, string | string[]>;

export interface QuestionCardProps
  extends Omit<ComponentProps<"div">, "part"> {
  part: ToolUIPart | DynamicToolUIPart;
  onAnswer?: (answers: QuestionCardAnswers) => void;
  disabled?: boolean;
}

/**
 * Compact paged wizard for the ask_user_question tool.
 *
 * One question renders per page to keep the card small; with multiple
 * questions a "< 2 / 3 >" pager steps between pages. Answering a
 * non-last single-select page stores the pick and auto-advances;
 * answering the last page submits every collected answer at once.
 * Single-question forms keep the historic direct-submit behavior.
 *
 * Chrome-less by design: the QuestionModal dialog provides the
 * surface, so this component renders content only.
 */
export function QuestionCard({
  part,
  onAnswer,
  disabled = false,
  className,
  ...props
}: QuestionCardProps) {
  const input = (part.input ?? {}) as Partial<QuestionCardInput>;
  const questions = Array.isArray(input.questions) ? input.questions : [];

  const isAnswered =
    part.state === "output-available" ||
    part.state === "approval-responded";

  const outputAnswers = (() => {
    if (!part.output) return undefined;
    if (
      typeof part.output === "object" &&
      part.output !== null &&
      "answers" in part.output &&
      typeof (part.output as { answers: unknown }).answers === "object"
    ) {
      return (part.output as { answers: QuestionCardAnswers }).answers;
    }
    if (typeof part.output === "object" && part.output !== null) {
      return part.output as QuestionCardAnswers;
    }
    return undefined;
  })();

  const isWizard = questions.length > 1;

  // ---- Wizard paging state (multi-question forms only) ----
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<
    Record<string, string[]>
  >({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  const q = isWizard ? questions[pageIndex] : questions[0];
  const isLastPage = isWizard && pageIndex === questions.length - 1;

  // All collected answers become the submitted payload.
  const collectedAnswers = (): QuestionCardAnswers => {
    const finalAnswers: QuestionCardAnswers = {};
    for (const question of questions) {
      const selected = selectedAnswers[question.question] ?? [];
      const custom = customInputs[question.question]?.trim();
      if (question.multiSelect) {
        finalAnswers[question.question] = selected;
      } else if (selected.length > 0) {
        finalAnswers[question.question] = selected[0];
      } else if (custom) {
        finalAnswers[question.question] = custom;
      }
    }
    return finalAnswers;
  };

  /** Advance, or submit from the last page. `justAnswered` merges the
   * option picked in this same click — state updates haven't applied
   * yet, so reading `selectedAnswers` alone would miss it. */
  const finishOrAdvance = (
    questionText: string,
    justAnswered?: string | string[]
  ) => {
    if (!isWizard) return; // single-question forms submit directly
    if (isLastPage) {
      if (onAnswer) {
        const finalAnswers = collectedAnswers();
        if (justAnswered !== undefined) {
          finalAnswers[questionText] = justAnswered;
        }
        onAnswer(finalAnswers);
      }
      return;
    }
    setPageIndex((i) => Math.min(i + 1, questions.length - 1));
  };

  const handleToggleOption = (
    questionText: string,
    optionLabel: string,
    multiSelect: boolean
  ) => {
    if (isAnswered || disabled) return;

    // Single-select, single-question: historic direct submit.
    if (!multiSelect && !isWizard && onAnswer) {
      onAnswer({ [questionText]: optionLabel });
      return;
    }

    // Single-select inside the wizard: store and advance (or submit
    // when already on the last page).
    if (!multiSelect) {
      setSelectedAnswers((prev) => ({
        ...prev,
        [questionText]: [optionLabel],
      }));
      finishOrAdvance(
        questionText,
        isLastPage ? optionLabel : undefined
      );
      return;
    }

    // Multi-select toggle (no auto-advance — options keep toggling
    // until the user presses the page's action button).
    setSelectedAnswers((prev) => {
      const current = prev[questionText] ?? [];
      const next = current.includes(optionLabel)
        ? current.filter((l) => l !== optionLabel)
        : [...current, optionLabel];
      return { ...prev, [questionText]: next };
    });
  };

  const handleCustomInputSubmit = (
    e: FormEvent,
    questionText: string
  ) => {
    e.preventDefault();
    const customText = customInputs[questionText]?.trim();
    if (!customText || isAnswered || disabled) return;

    if (!isWizard && onAnswer) {
      onAnswer({ [questionText]: customText });
      return;
    }
    setSelectedAnswers((prev) => ({
      ...prev,
      [questionText]: [customText],
    }));
    finishOrAdvance(questionText, isLastPage ? customText : undefined);
  };

  /** Multi-select pages need an explicit action button (toggling
   * options never auto-advances): "Submit Answer" for single-question
   * forms, "Next"/"Submit" inside the wizard. */
  const handlePageAction = () => {
    if (isAnswered || disabled || !q) return;
    if (!isWizard) {
      // Single-question multi-select: submit this page directly.
      if (onAnswer) {
        const selected = selectedAnswers[q.question] ?? [];
        const custom = customInputs[q.question]?.trim();
        onAnswer({
          [q.question]: q.multiSelect
            ? selected
            : (selected[0] ?? custom ?? ""),
        });
      }
      return;
    }
    if (isLastPage) {
      if (onAnswer) onAnswer(collectedAnswers());
      return;
    }
    setPageIndex((i) => Math.min(i + 1, questions.length - 1));
  };

  const pageNeedsAction = !isAnswered && (q?.multiSelect ?? false);

  // ---- Resolved state: read-only summary ----
  if (isAnswered && questions.length > 0) {
    return (
      <div
        className={cn("not-prose w-full space-y-4", className)}
        data-slot="question-card"
        {...props}
      >
        <div className="flex items-center gap-2">
          <MessageCircleQuestionIcon className="size-4 shrink-0 text-primary" />
          <Badge
            className="gap-1 text-xs font-normal"
            variant="secondary"
          >
            <CheckCircle2Icon className="size-3.5 text-success" />
            Answered
          </Badge>
        </div>
        <div className="space-y-4">
          {questions.map((question) => {
            const answeredVal = outputAnswers?.[question.question];
            return (
              <div className="space-y-2" key={question.question}>
                <Badge
                  className="font-mono text-[10px] tracking-wider uppercase"
                  variant="outline"
                >
                  {question.header}
                </Badge>
                <h4 className="text-balance font-medium text-sm text-foreground">
                  {question.question}
                </h4>
                {answeredVal ? (
                  <div className="bg-muted/40 p-2.5 text-xs ring-1 ring-foreground/10">
                    <span className="font-medium text-muted-foreground">
                      Selected:{" "}
                    </span>
                    <span className="font-medium text-foreground">
                      {Array.isArray(answeredVal)
                        ? answeredVal.join(", ")
                        : answeredVal}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (!q) return null;

  // ---- Pending state: compact paged wizard ----
  return (
    <div
      className={cn("not-prose w-full", className)}
      data-slot="question-card"
      {...props}
    >
      {/* Header row: marker + category chip + pager (wizard only).
          Right padding clears the modal's absolutely-positioned X. */}
      <div className="flex items-center justify-between gap-2 pr-9">
        <div className="flex min-w-0 items-center gap-2">
          <MessageCircleQuestionIcon className="size-4 shrink-0 text-primary" />
          <Badge
            className="shrink-0 font-mono text-[10px] tracking-wider uppercase"
            variant="outline"
          >
            {q.header}
          </Badge>
          {q.multiSelect && (
            <span className="text-[11px] text-muted-foreground">
              (Select multiple)
            </span>
          )}
        </div>
        {isWizard && (
          <div
            className="flex shrink-0 items-center gap-1"
            data-slot="question-pager"
          >
            <Button
              aria-label="Previous page"
              disabled={pageIndex === 0 || disabled}
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <ChevronLeftIcon />
            </Button>
            <span
              aria-live="polite"
              className="font-mono text-[11px] tabular-nums text-muted-foreground"
              data-slot="question-pager-position"
            >
              {pageIndex + 1} / {questions.length}
            </span>
            <Button
              aria-label="Next page"
              disabled={isLastPage || disabled}
              onClick={() =>
                setPageIndex((i) => Math.min(questions.length - 1, i + 1))
              }
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <ChevronRightIcon />
            </Button>
          </div>
        )}
      </div>

      {/* Current page — remounts per page for a subtle transition */}
      <div
        className="animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
        key={pageIndex}
      >
        <h4 className="mt-3 text-balance font-medium text-sm text-foreground">
          {q.question}
        </h4>

        {/* Options — one page only, keeping the card compact */}
        <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {q.options.map((opt) => {
            const isSelected = (
              selectedAnswers[q.question] ?? []
            ).includes(opt.label);

            return (
              <button
                className={cn(
                  "group flex flex-col justify-between gap-1.5 p-2.5 text-left ring-1 transition-all",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected
                    ? "bg-primary/5 ring-primary"
                    : "bg-card ring-foreground/10 hover:bg-muted/40 hover:ring-primary/40",
                  disabled && "cursor-not-allowed opacity-60"
                )}
                data-slot="question-option"
                data-selected={isSelected || undefined}
                disabled={disabled}
                key={opt.label}
                onClick={() =>
                  handleToggleOption(
                    q.question,
                    opt.label,
                    q.multiSelect ?? false
                  )
                }
                type="button"
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 break-words font-medium text-xs text-foreground group-hover:text-primary">
                      {opt.label}
                    </span>
                    {isSelected && (
                      <CheckIcon className="size-3.5 shrink-0 text-primary" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {opt.description}
                  </p>
                </div>

                {opt.preview && (
                  <div className="overflow-x-auto bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground ring-1 ring-foreground/10">
                    <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                      <Code2Icon className="size-3" />
                      Preview
                    </div>
                    <pre className="whitespace-pre-wrap">{opt.preview}</pre>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Custom "Other" answer for the current page */}
        <form
          className="mt-2.5 flex items-center gap-2"
          onSubmit={(e) => handleCustomInputSubmit(e, q.question)}
        >
          <Input
            className="h-8 text-xs"
            disabled={disabled}
            onChange={(e) =>
              setCustomInputs((prev) => ({
                ...prev,
                [q.question]: e.target.value,
              }))
            }
            placeholder="Other (type custom answer...)"
            value={customInputs[q.question] ?? ""}
          />
          <Button
            className="h-8 shrink-0 text-xs"
            disabled={disabled || !customInputs[q.question]?.trim()}
            size="sm"
            type="submit"
            variant="outline"
          >
            <SendIcon className="mr-1 size-3" />
            Submit Other
          </Button>
        </form>

        {/* Explicit action for multi-select pages (toggling options
            never auto-advances). */}
        {pageNeedsAction && (
          <div className="mt-2.5 flex justify-end">
            <Button
              className="h-8 text-xs"
              disabled={disabled}
              onClick={handlePageAction}
              size="sm"
              type="button"
            >
              {!isLastPage && isWizard ? "Next" : "Submit Answer"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
