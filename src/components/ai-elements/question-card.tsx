"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircle2Icon,
  CheckIcon,
  Code2Icon,
  HelpCircleIcon,
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

  // State for selections across all questions
  const [selectedAnswers, setSelectedAnswers] = useState<
    Record<string, string[]>
  >({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});

  const handleToggleOption = (
    questionText: string,
    optionLabel: string,
    multiSelect: boolean
  ) => {
    if (isAnswered || disabled) return;

    if (!multiSelect) {
      // Single select: if only 1 question, submit directly
      if (questions.length === 1 && onAnswer) {
        onAnswer({ [questionText]: optionLabel });
        return;
      }

      setSelectedAnswers((prev) => ({
        ...prev,
        [questionText]: [optionLabel],
      }));
      return;
    }

    // Multi-select toggle
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

    if (questions.length === 1 && onAnswer) {
      onAnswer({ [questionText]: customText });
      return;
    }

    setSelectedAnswers((prev) => ({
      ...prev,
      [questionText]: [customText],
    }));
  };

  const handleSubmitAll = () => {
    if (!onAnswer || isAnswered || disabled) return;

    const finalAnswers: QuestionCardAnswers = {};
    for (const q of questions) {
      const selected = selectedAnswers[q.question] ?? [];
      const custom = customInputs[q.question]?.trim();

      if (q.multiSelect) {
        finalAnswers[q.question] = selected;
      } else if (selected.length > 0) {
        finalAnswers[q.question] = selected[0];
      } else if (custom) {
        finalAnswers[q.question] = custom;
      }
    }

    onAnswer(finalAnswers);
  };

  const hasAnyMultiSelect = questions.some((q) => q.multiSelect);
  const showSubmitButton =
    !isAnswered && (questions.length > 1 || hasAnyMultiSelect);

  return (
    <div
      className={cn(
        "not-prose my-3 w-full rounded-md border border-border bg-card p-4 text-card-foreground shadow-xs",
        className
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <HelpCircleIcon className="size-4 text-primary" />
          <span className="font-semibold text-sm">Interactive Question</span>
        </div>
        {isAnswered && (
          <Badge
            className="gap-1 rounded-full text-xs font-normal"
            variant="secondary"
          >
            <CheckCircle2Icon className="size-3.5 text-green-600 dark:text-green-400" />
            Answered
          </Badge>
        )}
      </div>

      <div className="mt-4 space-y-6">
        {questions.map((q, qIndex) => {
          const isMulti = q.multiSelect ?? false;
          const currentSelections = selectedAnswers[q.question] ?? [];
          const answeredVal = outputAnswers?.[q.question];

          return (
            <div
              className="space-y-3"
              key={q.question || `question-${qIndex}`}
            >
              {/* Question Header Chip & Prompt */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Badge
                    className="font-mono text-[10px] tracking-wider uppercase"
                    variant="outline"
                  >
                    {q.header}
                  </Badge>
                  {isMulti && (
                    <span className="text-[11px] text-muted-foreground">
                      (Select multiple)
                    </span>
                  )}
                </div>
                <h4 className="font-medium text-sm text-foreground">
                  {q.question}
                </h4>
              </div>

              {/* If answered, display summary */}
              {isAnswered && answeredVal ? (
                <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
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

              {/* Options Grid */}
              {!isAnswered && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {q.options.map((opt) => {
                    const isSelected = currentSelections.includes(opt.label);

                    return (
                      <button
                        className={cn(
                          "group flex flex-col justify-between rounded-md border p-3 text-left transition-all",
                          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
                          isSelected
                            ? "border-primary bg-primary/5 ring-1 ring-primary"
                            : "border-border bg-card hover:border-primary/50 hover:bg-muted/30",
                          disabled && "cursor-not-allowed opacity-60"
                        )}
                        disabled={disabled}
                        key={opt.label}
                        onClick={() =>
                          handleToggleOption(q.question, opt.label, isMulti)
                        }
                        type="button"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-xs text-foreground group-hover:text-primary">
                              {opt.label}
                            </span>
                            {isSelected && (
                              <CheckIcon className="size-3.5 shrink-0 text-primary" />
                            )}
                          </div>
                          <p className="text-[11px] leading-relaxed text-muted-foreground">
                            {opt.description}
                          </p>
                        </div>

                        {/* Monospace preview box */}
                        {opt.preview && (
                          <div className="mt-2.5 overflow-x-auto rounded border border-border/60 bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
                            <div className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground/70">
                              <Code2Icon className="size-3" />
                              Preview
                            </div>
                            <pre className="whitespace-pre-wrap">
                              {opt.preview}
                            </pre>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Auto-appended "Other" input */}
              {!isAnswered && (
                <form
                  className="flex items-center gap-2 pt-1"
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
                    disabled={
                      disabled || !customInputs[q.question]?.trim()
                    }
                    size="sm"
                    type="submit"
                    variant="outline"
                  >
                    <SendIcon className="mr-1 size-3" />
                    Submit Other
                  </Button>
                </form>
              )}
            </div>
          );
        })}

        {/* Submit all answers if multiple questions or multi-select */}
        {showSubmitButton && (
          <div className="flex justify-end pt-2">
            <Button
              className="h-8 text-xs"
              disabled={disabled}
              onClick={handleSubmitAll}
              size="sm"
              type="button"
            >
              Submit Answer
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
