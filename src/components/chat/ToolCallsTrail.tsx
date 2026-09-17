"use client";

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  FileIcon,
  GlobeIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo } from "react";

type ToolCallsTrailProps = {
  label: string;
  parts: Array<ToolUIPart | DynamicToolUIPart>;
};

/** Whether one tool part still counts as an in-flight process step. */
function isPartProcessing(part: ToolUIPart | DynamicToolUIPart): boolean {
  return (
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    // A part frozen in approval-requested (e.g. an interrupted stream)
    // never resolved — the process is not finished, keep the trail open.
    part.state === "approval-requested"
  );
}

function getToolIcon(name: string) {
  if (
    name === "bash" ||
    name === "shell" ||
    name === "exec" ||
    name === "execute"
  )
    return TerminalIcon;
  if (
    name === "read" ||
    name === "write" ||
    name === "edit" ||
    name === "glob" ||
    name === "grep"
  )
    return FileIcon;
  if (name === "web_search" || name === "web_fetch") return SearchIcon;
  if (name.startsWith("fetch") || name.includes("http")) return GlobeIcon;
  return WrenchIcon;
}

/**
 * Renders non-research tool invocations as one unified ChainOfThought
 * trail ("Built-in Tools" / "MCP Tools").
 *
 * Auto-minimize: the trail stays open while any call is running (or
 * awaiting approval) and folds itself a second after the last call
 * completes. Purely historical trails mount already minimized — no
 * open-then-flash-fold on chat reload.
 */
export function ToolCallsTrail({ label, parts }: ToolCallsTrailProps) {
  const steps = useMemo(
    () =>
      parts.map((part) => {
        const name = getToolName(part);
        const running =
          part.state === "input-streaming" || part.state === "input-available";
        const awaiting = part.state === "approval-requested";
        const status = running ? "active" : awaiting ? "pending" : "complete";

        let description: string | undefined;
        if (part.state === "output-available" && part.output) {
          const outputStr =
            typeof part.output === "string"
              ? part.output
              : JSON.stringify(part.output);
          description =
            outputStr.slice(0, 120) + (outputStr.length > 120 ? "…" : "");
        } else if (part.state === "output-error") {
          description = `Error: ${part.errorText}`;
        }

        const labelText = `${awaiting ? "Awaiting approval" : running ? "Running" : "Called"} ${name}`;

        return (
          <ChainOfThoughtStep
            description={description}
            icon={getToolIcon(name)}
            key={part.toolCallId}
            label={labelText}
            status={status}
          />
        );
      }),
    [parts]
  );

  if (parts.length === 0) return null;

  const isProcessing = parts.some(isPartProcessing);

  return (
    <ChainOfThought
      className="mb-4"
      defaultOpen={isProcessing}
      isProcessing={isProcessing}
    >
      <ChainOfThoughtHeader>
        {`${label} — ${parts.length} step${parts.length === 1 ? "" : "s"}`}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>{steps}</ChainOfThoughtContent>
    </ChainOfThought>
  );
}