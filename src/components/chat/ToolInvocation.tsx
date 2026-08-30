"use client";

import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

type ToolInvocationProps = {
  part: ToolUIPart | DynamicToolUIPart;
  onApproveTool?: (approvalId: string) => void;
  onDenyTool?: (approvalId: string, reason?: string) => void;
};

/**
 * Renders a single tool invocation part (static `tool-*` or `dynamic-tool`)
 * using the collapsible Tool component and Confirmation approval gate. Completed
 * and errored tools open by default so their results are visible immediately.
 */
export function ToolInvocation({
  part,
  onApproveTool,
  onDenyTool,
}: ToolInvocationProps) {
  const showOpen =
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "approval-requested";

  const approval = "approval" in part ? part.approval : undefined;
  const toolDisplayName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.split("-").slice(1).join("-");

  return (
    <Tool defaultOpen={showOpen}>
      {part.type === "dynamic-tool" ? (
        <ToolHeader state={part.state} toolName={part.toolName} type={part.type} />
      ) : (
        <ToolHeader state={part.state} type={part.type} />
      )}
      <ToolContent>
        {approval && (
          <Confirmation approval={approval} state={part.state}>
            <ConfirmationTitle>
              Tool Approval Required: {toolDisplayName}
            </ConfirmationTitle>
            <ConfirmationRequest>
              <div className="text-xs text-muted-foreground">
                This tool execution requires confirmation before proceeding.
              </div>
            </ConfirmationRequest>
            <ConfirmationAccepted>
              <div className="text-xs text-green-600 font-medium">
                Execution approved by user.
              </div>
            </ConfirmationAccepted>
            <ConfirmationRejected>
              <div className="text-xs text-destructive font-medium">
                Execution denied by user
                {approval.reason ? `: ${approval.reason}` : "."}
              </div>
            </ConfirmationRejected>
            <ConfirmationActions>
              <ConfirmationAction
                onClick={() => onDenyTool?.(approval.id, "User denied execution")}
                variant="outline"
              >
                Deny
              </ConfirmationAction>
              <ConfirmationAction
                onClick={() => onApproveTool?.(approval.id)}
                variant="default"
              >
                Accept
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        )}
        <ToolInput input={part.input} />
        <ToolOutput errorText={part.errorText} output={part.output} />
      </ToolContent>
    </Tool>
  );
}
