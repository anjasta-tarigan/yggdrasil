"use client";

import { memo } from "react";
import { Brain } from "@phosphor-icons/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ReasoningEffortBadgeProps = {
  /** Resolved effort for active or last turn: "xhigh" | "high" | "medium" | "low" | "none" */
  activeEffort?: string | null;
  /** Whether the generation is currently streaming */
  isStreaming?: boolean;
  /** Whether the model is actively outputting reasoning/thinking tokens */
  isThinking?: boolean;
  className?: string;
};

const EFFORT_LABELS: Record<string, { label: string; badge: string; desc: string }> = {
  xhigh: {
    label: "Extended",
    badge: "text-accent-foreground bg-accent/10 border-accent/20",
    desc: "Max reasoning depth (up to 32k tokens) for complex architectures, proofs, and concurrency analysis.",
  },
  high: {
    label: "High",
    badge: "text-primary bg-primary/10 border-primary/20",
    desc: "Deep reasoning (~16k tokens) for feature implementations, algorithms, and complex queries.",
  },
  medium: {
    label: "Medium",
    badge: "text-secondary-foreground bg-secondary/50 border-secondary",
    desc: "Balanced reasoning (~8k tokens) for concept explanations, code reviews, and trade-offs.",
  },
  low: {
    label: "Low",
    badge: "text-warning bg-warning/10 border-warning/20",
    desc: "Fast reasoning (~2k tokens) for quick edits, syntax tweaks, and localized formatting.",
  },
  none: {
    label: "Direct",
    badge: "text-success bg-success/10 border-success/20",
    desc: "Zero reasoning tokens for instant direct responses, translations, and casual conversation.",
  },
};

export const ReasoningEffortBadge = memo(function ReasoningEffortBadge({
  activeEffort,
  isStreaming = false,
  isThinking = false,
  className,
}: ReasoningEffortBadgeProps) {
  const info = activeEffort ? EFFORT_LABELS[activeEffort] : undefined;
  const displayLabel = info ? info.label : "Auto";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={`Reasoning: ${displayLabel}`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-all select-none",
              isThinking
                ? "border-primary/40 bg-primary/10 text-primary shadow-xs animate-pulse"
                : isStreaming
                ? "border-primary/30 bg-primary/5 text-foreground"
                : info
                ? info.badge
                : "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
              className
            )}
          >
            <Brain
              className={cn(
                "size-3.5 shrink-0 transition-transform",
                isThinking && "scale-110 text-primary animate-spin-slow"
              )}
              weight={isThinking || activeEffort ? "fill" : "regular"}
            />
            <span className="truncate">
              {isThinking
                ? info
                  ? `Thinking (${info.label})`
                  : "Thinking..."
                : isStreaming
                ? info
                  ? `Reasoning: ${info.label}`
                  : "Reasoning: Auto"
                : `Reasoning: ${displayLabel}`}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-[280px] p-2.5 text-xs" side="top">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between font-semibold">
              <span>Reasoning: {displayLabel}</span>
              {activeEffort && (
                <span className="text-[10px] text-muted-foreground uppercase font-mono">
                  {activeEffort}
                </span>
              )}
            </div>
            <p className="text-muted-foreground">
              {info
                ? info.desc
                : "Proactively auto-adapts thinking depth based on task complexity and learned procedural memory rules."}
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
});
