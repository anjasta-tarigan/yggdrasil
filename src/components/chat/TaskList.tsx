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
  in_progress: (
    <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
  ),
  completed: <CheckCircleIcon className="size-3.5 shrink-0 text-green-600" />,
};

/**
 * Renders the latest manage_tasks invocation as a Task checklist.
 */
export function TaskList({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const output =
    part.state === "output-available"
      ? (part.output as TasksListData | undefined)
      : undefined;
  const input = (part.input ?? {}) as TasksListData;
  const title = output?.title ?? input.title ?? "Task plan";
  const items = output?.items ?? input.items ?? [];
  const completed = items.filter((item) => item.status === "completed").length;

  return (
    <Task className="mb-4" defaultOpen>
      <TaskTrigger title={`${title} (${completed}/${items.length})`} />
      <TaskContent>
        {items.map((item, i) => (
          <TaskItem key={`${item.text}-${i}`}>
            <span className="inline-flex items-center gap-2">
              {taskStatusIcon[item.status] ?? taskStatusIcon.pending}
              {item.text}
            </span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}
