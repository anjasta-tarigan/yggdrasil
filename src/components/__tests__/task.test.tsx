import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { ComponentProps } from "react";
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => cleanup());
afterEach(() => cleanup());

const AUTO_CLOSE_DELAY = 1000;

type TaskProps = ComponentProps<typeof Task>;

function TaskTrail(props: TaskProps) {
  return (
    <Task {...props}>
      <TaskTrigger title="Plan" />
      <TaskContent>
        <div>First todo</div>
      </TaskContent>
    </Task>
  );
}

/** Advance virtual time past the auto-close grace delay (act-flushed). */
async function advancePastDelay() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_DELAY + 10);
  });
}

describe("Task auto-close (auto-minimize when complete)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays open while the task list is processing", async () => {
    render(<TaskTrail defaultOpen isProcessing />);
    expect(screen.getByText("First todo")).toBeInTheDocument();

    await advancePastDelay();
    // Still processing — never folds.
    expect(screen.getByText("First todo")).toBeInTheDocument();
  });

  it("auto-closes after the grace delay once processing completes", async () => {
    const { rerender } = render(<TaskTrail defaultOpen isProcessing />);
    rerender(<TaskTrail defaultOpen isProcessing={false} />);
    await advancePastDelay();
    expect(screen.queryByText("First todo")).toBeNull();
  });

  it("auto-opens when processing starts from a closed state", async () => {
    const { rerender } = render(
      <TaskTrail defaultOpen={false} isProcessing={false} />
    );
    expect(screen.queryByText("First todo")).toBeNull();
    rerender(<TaskTrail defaultOpen={false} isProcessing />);
    expect(screen.getByText("First todo")).toBeInTheDocument();
  });

  it("manual re-open after auto-close sticks", async () => {
    const { rerender } = render(<TaskTrail defaultOpen isProcessing />);
    rerender(<TaskTrail defaultOpen isProcessing={false} />);
    await advancePastDelay();
    expect(screen.queryByText("First todo")).toBeNull();

    // User re-opens the folded trail.
    fireEvent.click(screen.getByText("Plan"));
    expect(screen.getByText("First todo")).toBeInTheDocument();

    // Subsequent rerenders (message stream updates) must not clobber it.
    rerender(<TaskTrail defaultOpen isProcessing={false} />);
    await advancePastDelay();
    expect(screen.getByText("First todo")).toBeInTheDocument();
  });

  it("manual close mid-processing is not forced open by rerenders", async () => {
    const { rerender } = render(<TaskTrail defaultOpen isProcessing />);
    fireEvent.click(screen.getByText("Plan"));
    expect(screen.queryByText("First todo")).toBeNull();

    rerender(<TaskTrail defaultOpen isProcessing />);
    expect(screen.queryByText("First todo")).toBeNull();
  });

  it("ignores isProcessing when open is controlled", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <TaskTrail open={false} onOpenChange={onOpenChange} isProcessing />
    );
    expect(screen.queryByText("First todo")).toBeNull();

    rerender(
      <TaskTrail open={false} onOpenChange={onOpenChange} isProcessing={false} />
    );
    await advancePastDelay();
    expect(screen.queryByText("First todo")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
