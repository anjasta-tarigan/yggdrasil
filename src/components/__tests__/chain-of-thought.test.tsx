import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import type { ComponentProps } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => cleanup());
afterEach(() => cleanup());

const AUTO_CLOSE_DELAY = 1000;

type TrailProps = ComponentProps<typeof ChainOfThought>;

function Trail(props: TrailProps) {
  return (
    <ChainOfThought {...props}>
      <ChainOfThoughtHeader>Research steps</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        <ChainOfThoughtStep label="Step one" status="complete" />
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

/** Advance virtual time past the auto-close grace delay (act-flushed). */
async function advancePastDelay() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_DELAY + 10);
  });
}

describe("ChainOfThought auto-close (auto-minimize when complete)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays open and shows steps while processing", () => {
    render(<Trail defaultOpen isProcessing />);
    expect(screen.getByText("Step one")).toBeInTheDocument();
  });

  it("auto-closes after the grace delay once processing completes", async () => {
    const { rerender } = render(<Trail defaultOpen isProcessing />);
    expect(screen.getByText("Step one")).toBeInTheDocument();

    // Process completes -> the trail folds itself after the delay.
    rerender(<Trail defaultOpen isProcessing={false} />);
    await advancePastDelay();

    expect(screen.queryByText("Step one")).toBeNull();
  });

  it("auto-opens when processing starts from a closed state", () => {
    // defaultOpen=false, isProcessing=true -> open without user action.
    render(<Trail isProcessing />);
    expect(screen.getByText("Step one")).toBeInTheDocument();
  });

  it("does not auto-close content the user manually re-opened", async () => {
    const { rerender } = render(<Trail defaultOpen isProcessing />);
    rerender(<Trail defaultOpen isProcessing={false} />);
    await advancePastDelay();
    expect(screen.queryByText("Step one")).toBeNull();

    // User re-opens the folded trail.
    fireEvent.click(screen.getByText("Research steps"));
    expect(screen.getByText("Step one")).toBeInTheDocument();

    // A subsequent completed rerender must not yank it away again.
    rerender(<Trail defaultOpen isProcessing={false} />);
    await advancePastDelay();

    expect(screen.getByText("Step one")).toBeInTheDocument();
  });

  it("does not clobber a manual re-open made during the grace countdown", async () => {
    const { rerender } = render(<Trail defaultOpen isProcessing />);
    rerender(<Trail defaultOpen isProcessing={false} />);

    // During the grace countdown the trail is still open; the user
    // toggles it shut, then re-opens it before the timer fires.
    fireEvent.click(screen.getByText("Research steps"));
    expect(screen.queryByText("Step one")).toBeNull();
    fireEvent.click(screen.getByText("Research steps"));
    expect(screen.getByText("Step one")).toBeInTheDocument();

    await advancePastDelay();

    // The pending auto-close must not yank the user's fresh open away.
    expect(screen.getByText("Step one")).toBeInTheDocument();
  });

  it("keeps manual close while processing out of the way (no forced open)", async () => {
    // User closes the trail mid-process; it stays closed.
    const { rerender } = render(<Trail defaultOpen isProcessing />);
    fireEvent.click(screen.getByText("Research steps"));
    expect(screen.queryByText("Step one")).toBeNull();

    rerender(<Trail defaultOpen isProcessing />);
    // Still processing, still closed — user's close wins.
    expect(screen.queryByText("Step one")).toBeNull();
    await advancePastDelay();
    expect(screen.queryByText("Step one")).toBeNull();
  });

  it("ignores isProcessing entirely when open is controlled", async () => {
    // Controlled open: the parent owns the state; auto behavior must
    // never fight it in either direction.
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Trail open={false} onOpenChange={onOpenChange} isProcessing />
    );
    // Auto-open must NOT fire: the parent said closed.
    expect(screen.queryByText("Step one")).toBeNull();

    rerender(<Trail open={false} onOpenChange={onOpenChange} isProcessing={false} />);
    await advancePastDelay();
    // Auto-close has nothing to do and no onOpenChange may be emitted.
    expect(screen.queryByText("Step one")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
