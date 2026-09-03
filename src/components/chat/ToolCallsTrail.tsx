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

function getToolIcon(name: string) {
  if (name === "bash" || name === "execute") return TerminalIcon;
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

  return (
    <ChainOfThought className="mb-4" defaultOpen>
      <ChainOfThoughtHeader>
        {`${label} — ${parts.length} step${parts.length === 1 ? "" : "s"}`}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>{steps}</ChainOfThoughtContent>
    </ChainOfThought>
  );
}