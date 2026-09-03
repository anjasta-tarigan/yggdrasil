import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ToolCallsTrail } from "@/components/chat/ToolCallsTrail";
import type { ToolUIPart } from "ai";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => cleanup());
afterEach(() => cleanup());

const completedBash: ToolUIPart = {
  type: "tool-bash",
  state: "output-available",
  toolCallId: "call-bash-done",
  input: { command: "ls -la" },
  output: "file-a\nfile-b",
} as unknown as ToolUIPart;

const runningBash: ToolUIPart = {
  type: "tool-bash",
  state: "input-available",
  toolCallId: "call-bash-live",
  input: { command: "npm test" },
} as unknown as ToolUIPart;

/** Advance virtual time past the auto-close grace delay (act-flushed). */
async function advancePastDelay() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1010);
  });
}

describe("ToolCallsTrail auto-close (auto-minimize when complete)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts folded for a fully completed historical trail", () => {
    render(<ToolCallsTrail label="Built-in Tools" parts={[completedBash]} />);
    expect(
      screen.getByText("Built-in Tools — 1 step")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Called bash/)).toBeNull();
  });

  it("mounts open and stays open while a call is running", async () => {
    render(<ToolCallsTrail label="Built-in Tools" parts={[runningBash]} />);
    expect(screen.getByText(/Running bash/)).toBeInTheDocument();
    await advancePastDelay();
    expect(screen.getByText(/Running bash/)).toBeInTheDocument();
  });

  it("folds after the grace delay once every call completes", async () => {
    const { rerender } = render(
      <ToolCallsTrail label="Built-in Tools" parts={[completedBash, runningBash]} />
    );
    expect(screen.getByText(/Running bash/)).toBeInTheDocument();

    const resolved: ToolUIPart = {
      ...runningBash,
      state: "output-available",
      output: "ok",
    } as unknown as ToolUIPart;
    rerender(
      <ToolCallsTrail label="Built-in Tools" parts={[completedBash, resolved]} />
    );
    // Both calls now complete and visible while the trail is open.
    expect(screen.getAllByText(/Called bash/)).toHaveLength(2);

    await advancePastDelay();
    expect(screen.queryByText(/Called bash/)).toBeNull();
  });
});
