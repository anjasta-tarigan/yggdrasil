import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { RotatingShimmer, Shimmer } from "@/components/ai-elements/shimmer";

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("RotatingShimmer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the first phrase and cycles to the next on the interval", () => {
    const phrases = ["One", "Two", "Three"];
    render(<RotatingShimmer phrases={phrases} intervalMs={1000} />);

    expect(screen.getByText("One")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Two")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("Three")).toBeInTheDocument();

    // Wraps around to the first phrase.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("One")).toBeInTheDocument();
  });

  it("renders a single phrase statically without a timer", () => {
    render(<RotatingShimmer phrases={["Only"]} />);
    expect(screen.getByText("Only")).toBeInTheDocument();
  });
});

describe("Shimmer", () => {
  it("renders its text content", () => {
    render(<Shimmer>Thinking</Shimmer>);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });
});
