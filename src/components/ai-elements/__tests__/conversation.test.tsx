import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Conversation, ConversationScrollButton } from "../conversation";

const mockScrollToBottom = vi.fn();

vi.mock("use-stick-to-bottom", () => ({
  StickToBottom: Object.assign(
    vi.fn(({ children, initial, resize, ...props }) => (
      <div
        data-testid="stick-to-bottom"
        data-initial={initial}
        data-resize={resize}
        {...props}
      >
        {children}
      </div>
    )),
    {
      Content: vi.fn(({ children, ...props }) => (
        <div data-testid="stick-to-bottom-content" {...props}>
          {children}
        </div>
      )),
    }
  ),
  useStickToBottomContext: () => ({
    isAtBottom: false,
    scrollToBottom: mockScrollToBottom,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Conversation and auto-scroll defaults", () => {
  it("defaults initial and resize to instant for reactive token streaming without spring animation lag", () => {
    render(<Conversation><div>Message</div></Conversation>);

    const el = screen.getByTestId("stick-to-bottom");
    expect(el.getAttribute("data-initial")).toBe("instant");
    expect(el.getAttribute("data-resize")).toBe("instant");
  });

  it("smooth scrolls to bottom when user explicitly clicks the scroll button", () => {
    render(<ConversationScrollButton />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
    expect(mockScrollToBottom).toHaveBeenCalledWith({ animation: "smooth" });
  });
});
