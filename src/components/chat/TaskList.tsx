"use client";

import {
  CheckCircleIcon,
  CircleIcon,
  LoaderCircleIcon,
} from "lucide-react";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@/components/ai-elements/task";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ReactNode } from "react";

type TaskItemData = {
  text: string;
  status: "pending" | "in_progress" | "completed";
};

type TasksListData = {
  title?: string;
  items?: TaskItemData[];
};

const taskStatusIcon: Record<TaskItemData["status"], ReactNode> = {
  pending: <CircleIcon className="size-3.5 shrink-0" />,
  in_progress: <LoaderCircleIcon className="size-3.5 shrink-0" />,
  completed: <CheckCircleIcon className="size-3.5 shrink-0 text-success" />,
};

/**
 * Renders the latest task_list_manager invocation as a Task checklist.
 *
 * Auto-minimize: the list stays open while the part is unfinished or
 * any checklist item is still pending/in-progress, and folds itself a
 * second after everything completes. Fully historical lists mount
 * already minimized — no open-then-flash-fold on chat reload.
 */
export function TaskList({
  part,
  isStreaming,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  /** Whether the parent message is still streaming. When false and items
   *  remain incomplete, the task is no longer being actively worked on and
   *  should auto-collapse instead of appearing stuck open. */
  isStreaming?: boolean;
}) {
  const output =
    part.state === "output-available"
      ? (part.output as TasksListData | undefined)
      : undefined;
  const input = (part.input ?? {}) as TasksListData;
  const title = output?.title ?? input.title ?? "Task plan";
  // `items` comes from an untrusted tool part whose input/output is `unknown`
  // at runtime (static and dynamic/legacy tool variants both flow through
  // here). Guarantee an array so .filter/.map never throw when the tool
  // returned a non-array (e.g. a string) for `items`.
  const rawItems = output?.items ?? input.items ?? [];
  const items: TaskItemData[] = Array.isArray(rawItems) ? rawItems : [];
  const completed = items.filter((item) => item.status === "completed").length;

  // The tool call's snapshot may be written (output-available) while
  // the checklist itself is still executing — items win. Errors count
  // as finished (nothing more will happen).
  // When the message is no longer streaming, treat incomplete items as
  // abandoned rather than in-progress so the task auto-collapses.
  const dataDrivenProcessing =
    part.state === "output-available"
      ? completed < items.length
      : part.state !== "output-error";
  const isProcessing = isStreaming !== false && dataDrivenProcessing;
  // An undone item's in-progress spinner should only animate while the
  // turn is actually streaming. Once the process is done it must not keep
  // reading as "still running on some phase".
  const running = isStreaming !== false;

  return (
    <Task
      className="mb-4"
      defaultOpen={isProcessing}
      isProcessing={isProcessing}
    >
      <TaskTrigger title={`${title} (${completed}/${items.length})`} />
      <TaskContent>
        {items.map((item, i) => (
          <TaskItem key={`${item.text}-${i}`}>
            <span className="inline-flex items-center gap-2">
              {item.status === "in_progress" && running ? (
                <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
              ) : (
                taskStatusIcon[item.status] ?? taskStatusIcon.pending
              )}
              {item.text}
            </span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}