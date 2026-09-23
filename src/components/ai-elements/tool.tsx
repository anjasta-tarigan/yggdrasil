"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CaretDown,
  CheckCircle,
  Circle,
  Clock,
  Wrench,
  XCircle,
} from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <Clock className="size-4 text-warning" />,
  "approval-responded": <CheckCircle className="size-4 text-primary" />,
  "input-available": <Clock className="size-4 animate-pulse" />,
  "input-streaming": <Circle className="size-4" />,
  "output-available": <CheckCircle className="size-4 text-success" />,
  "output-denied": <XCircle className="size-4 text-warning" />,
  "output-error": <XCircle className="size-4 text-destructive" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <Wrench className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title ?? derivedName}</span>
        {getStatusBadge(state)}
      </div>
      <CaretDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: ToolPart["output"];
  errorText?: ToolPart["errorText"];
  state?: ToolPart["state"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  state,
  ...props
}: ToolOutputProps) => {
  // Distinguish pending tool execution from resolved-but-falsy outputs (e.g. "", 0, null).
  // Truthiness checks mistakenly treat legitimate empty/zero returns as still-running.
  const isPending = state
    ? state === "input-streaming" ||
      state === "input-available" ||
      state === "approval-requested" ||
      state === "approval-responded"
    : output === undefined && !errorText;

  if (isPending) {
    return (
      <div className={cn("space-y-2", className)} {...props}>
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Result
        </h4>
        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          Pending...
        </div>
      </div>
    );
  }

  if (state === "output-denied") {
    return (
      <div className={cn("space-y-2", className)} {...props}>
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Result
        </h4>
        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          Execution denied
        </div>
      </div>
    );
  }

  const isEmpty =
    !errorText &&
    (output === null ||
      output === undefined ||
      output === "" ||
      (typeof output === "string" && output.trim() === ""));

  let Output: ReactNode;
  if (isEmpty) {
    Output = <div className="p-3 text-muted-foreground">No output</div>;
  } else if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  } else if (typeof output === "number" || typeof output === "boolean") {
    Output = <div className="p-3 font-mono">{String(output)}</div>;
  } else {
    Output = <div className="p-3">{output as ReactNode}</div>;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive p-3"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {!errorText && Output}
      </div>
    </div>
  );
};
