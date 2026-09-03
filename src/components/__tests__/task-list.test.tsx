import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { TaskList } from "@/components/chat/TaskList";
import type { DynamicToolUIPart } from "ai";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => cleanup());
afterEach(() => cleanup());

const items = (list: Array<"pending" | "in_progress" | "completed">) => ({
  title: "Plan",
  items: list.map((status, i) => ({ text: `Step ${i + 1}`, status })),
});

const taskPart = (
  state: "input-available" | "output-available",
  data: ReturnType<typeof items>
): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolCallId: "call-tasks",
    toolName: "task_list_manager",
    state,
    ...(state === "output-available"
      ? { output: data }
      : { input: data }),
  }) as unknown as DynamicToolUIPart;

/** Advance virtual time past the auto-close grace delay (act-flushed). */
async function advancePastDelay() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1010);
  });
}

describe("TaskList auto-close (auto-minimize when complete)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays open while tool output exists but items are unfinished", async () => {
    // The part snapshot is written, but the checklist itself is still
    // being executed — the list must not fold under the running work.
    render(
      <TaskList
        part={taskPart("output-available", items(["completed", "in_progress", "pending"]))}
      />
    );
    expect(screen.getByText("Step 2")).toBeInTheDocument();
    await advancePastDelay();
    expect(screen.getByText("Step 2")).toBeInTheDocument();
  });

  it("folds after the grace delay once every item completes", async () => {
    const { rerender } = render(
      <TaskList
        part={taskPart("output-available", items(["completed", "in_progress"]))}
      />
    );
    expect(screen.getByText("Step 2")).toBeInTheDocument();

    rerender(
      <TaskList
        part={taskPart("output-available", items(["completed", "completed"]))}
      />
    );
    expect(screen.getByText("Step 2")).toBeInTheDocument();

    await advancePastDelay();
    expect(screen.queryByText("Step 2")).toBeNull();
  });

  it("mounts folded for a fully completed historical task list", () => {
    render(
      <TaskList
        part={taskPart("output-available", items(["completed", "completed"]))}
      />
    );
    // Header stays; item content is minimized.
    expect(screen.getByText(/Plan \(2\/2\)/)).toBeInTheDocument();
    expect(screen.queryByText("Step 1")).toBeNull();
  });
});
