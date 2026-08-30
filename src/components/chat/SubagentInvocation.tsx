"use client";

import { LoaderCircleIcon } from "lucide-react";
import {
  Tool,
  ToolContent,
  ToolHeader,
} from "@/components/ai-elements/tool";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

type SubagentInvocationProps = {
  part: ToolUIPart | DynamicToolUIPart;
};

/**
 * Renders a delegate_<subagent> tool invocation: the assigned task, the
 * subagent's accumulated work (its streamed UIMessage parts — nested tool
 * calls and text), and the final summary the main model receives.
 */
export function SubagentInvocation({ part }: SubagentInvocationProps) {
  const input = (part.input ?? {}) as { task?: string };
  const task = typeof input.task === "string" ? input.task : "";
  // Preliminary results carry state output-available WITH preliminary:true
  // while the subagent is still streaming — the SDK keeps updating the same
  // part until the generator returns. Treat those as still running.
  const preliminary = (part as { preliminary?: boolean }).preliminary === true;
  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "output-available" && preliminary);

  // Output is the accumulated UIMessage the subagent produced (streamed
  // via preliminary tool results).
  const output = part.state === "output-available" ? part.output : undefined;
  const subMessage = output as
    | {
        parts?: Array<
          | { type: "text"; text: string }
          | { type: `tool-${string}`; toolCallId: string; state: string }
          | {
              type: "dynamic-tool";
              toolName: string;
              toolCallId: string;
              state: string;
            }
        >;
      }
    | undefined;

  const subTextParts =
    subMessage?.parts?.filter(
      (p): p is { type: "text"; text: string } => p.type === "text"
    ) ?? [];
  const finalText = subTextParts[subTextParts.length - 1]?.text;
  // Count ACTUAL tool parts inside the subagent's message — not total-minus-
  // text (step-start and reasoning parts would inflate the number).
  const subToolParts =
    subMessage?.parts?.filter(
      (p) =>
        (p.type.startsWith("tool-") || p.type === "dynamic-tool") as boolean
    ) ?? [];
  const subToolCount = subToolParts.length;
  const errored = part.state === "output-error";
  const errorText = (part as { errorText?: string }).errorText;

  return (
    <Tool className="mb-4" defaultOpen={!running || Boolean(errorText)}>
      {part.type === "dynamic-tool" ? (
        <ToolHeader
          state={part.state}
          toolName={part.toolName}
          type={part.type}
        />
      ) : (
        <ToolHeader state={part.state} type={part.type} />
      )}
      <ToolContent>
        {task && (
          <div className="rounded-md bg-muted/50 p-2 text-xs">
            <span className="font-medium">Task: </span>
            {task}
          </div>
        )}
        {subToolCount > 0 && (
          <div className="text-xs text-muted-foreground">
            {subToolCount} internal tool call{subToolCount === 1 ? "" : "s"}
          </div>
        )}
        {running && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            Subagent working…
          </div>
        )}
        {errored && errorText && (
          <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {errorText}
          </div>
        )}
        {finalText && (
          <div className="rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap">
            {finalText}
          </div>
        )}
        {!finalText && !running && !errored && (
          <div className="text-xs text-muted-foreground">
            Subagent finished without a text summary.
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}
